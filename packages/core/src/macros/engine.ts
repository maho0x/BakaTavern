import type { MacroEnv, VariableScope } from './env.ts';
import { parseMacros, type MacroAstNode, type MacroNode } from './parser.ts';
import type { MacroRegistry, MacroResult } from './registry.ts';
import { addVariable, isFalsyValue, readVariablePath, stringifyValue } from './variables.ts';

/** Marker `{{else}}` leaves behind; `if` splits on the raw `{{else}}` before evaluating. */
export const ELSE_MARKER = '\u0000\u001fELSE\u001f\u0000';
/** Marker for the non-scoped `{{trim}}`, removed together with surrounding newlines afterwards. */
export const TRIM_MARKER = '\u0000\u001fTRIM\u001f\u0000';
/** Per-evaluation state of `{{original}}`, which is substituted only once (SillyTavern). */
export const ORIGINAL_STATE = Symbol('original');

const MAX_DEPTH = 32;

/** Trims scoped content and removes the indentation of its first non-empty line from all lines. */
export function trimScopedContent(content: string): string {
  if (!content) return '';
  const lines = content.split('\n');
  const first = lines.find((line) => line.trim() !== '');
  const baseIndent = first ? (/^[ \t]*/.exec(first)?.[0].length ?? 0) : 0;
  if (baseIndent === 0) return content.trim();
  return lines
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      return indent >= baseIndent ? line.slice(baseIndent) : line.trimStart();
    })
    .join('\n')
    .trim();
}

export function normalizeResult(result: MacroResult): string {
  return stringifyValue(result);
}

/** Splits raw `if` content on its top-level `{{else}}`. */
export function splitOnTopLevelElse(raw: string): { thenBranch: string; elseBranch?: string } {
  const nodes = parseMacros(raw);
  let depth = 0;
  for (const node of nodes) {
    if (node.type !== 'macro' || node.kind !== 'call') continue;
    const name = node.name.toLowerCase();
    if (name === 'if') {
      depth += node.closing ? -1 : 1;
    } else if (name === 'else' && depth === 0) {
      return { thenBranch: raw.slice(0, node.start), elseBranch: raw.slice(node.end) };
    }
  }
  return { thenBranch: raw };
}

/** Legacy `<USER>`-style placeholders that predate curly-brace macros. */
const LEGACY = /<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi;

export class MacroEngine {
  readonly registry: MacroRegistry;

  constructor(registry: MacroRegistry) {
    this.registry = registry;
  }

  /** Replaces every macro in `text`. Unknown macros are left as written. */
  evaluate(text: string, env: MacroEnv): string {
    if (!text) return '';
    let input = text;
    if (/<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.test(input)) {
      input = input.replace(LEGACY, (_, tag: string) => {
        switch (tag.toUpperCase()) {
          case 'USER':
            return env.user;
          case 'GROUP':
            return env.group ?? env.char;
          case 'CHARIFNOTGROUP':
            return env.isGroup ? (env.group ?? env.char) : env.char;
          default:
            return env.char;
        }
      });
    }
    if (!input.includes('{{')) return input;
    const scopedEnv = env.original === undefined ? env : { ...env, [ORIGINAL_STATE]: { used: false } };
    let out = this.#evaluateText(input, scopedEnv, 0, 0);
    if (out.includes(TRIM_MARKER)) {
      out = out.replace(new RegExp(`(?:\\r?\\n)*${TRIM_MARKER}(?:\\r?\\n)*`, 'g'), '');
    }
    return out.replaceAll(ELSE_MARKER, '');
  }

  #evaluateText(text: string, env: MacroEnv, offset: number, depth: number): string {
    if (depth > MAX_DEPTH || !text.includes('{{')) return text;
    const nodes = parseMacros(text);
    const pairs = this.#pairScopes(nodes);
    let out = '';
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.type === 'text') {
        out += node.value;
        continue;
      }
      const close = pairs.get(i);
      if (close !== undefined) {
        const closing = nodes[close] as MacroNode;
        out += this.#evaluateMacro(node, env, offset, depth, {
          content: text.slice(node.end, closing.start),
          start: node.end,
        });
        i = close;
      } else if (node.closing) {
        out += node.raw;
      } else {
        out += this.#evaluateMacro(node, env, offset, depth, null);
      }
    }
    return out;
  }

  #pairScopes(nodes: MacroAstNode[]): Map<number, number> {
    const pairs = new Map<number, number>();
    const stack: { index: number; name: string }[] = [];
    nodes.forEach((node, index) => {
      if (node.type !== 'macro' || node.kind !== 'call') return;
      const name = node.name.toLowerCase();
      if (node.closing) {
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]!.name === name) {
            pairs.set(stack[s]!.index, index);
            stack.length = s;
            break;
          }
        }
      } else if (this.registry.acceptsScope(name, node.args.length)) {
        stack.push({ index, name });
      }
    });
    return pairs;
  }

  #evaluateMacro(
    node: MacroNode,
    env: MacroEnv,
    offset: number,
    depth: number,
    scoped: { content: string; start: number } | null,
  ): string {
    if (node.kind === 'variable') return this.#evaluateVariable(node, env, offset, depth);

    // Dynamic macros take precedence over registered ones (SillyTavern `#resolveMacro`).
    const dynamic =
      env.dynamic && Object.entries(env.dynamic).find(([k]) => k.toLowerCase() === node.name.toLowerCase());
    if (dynamic) {
      const value = dynamic[1];
      if (typeof value !== 'function') return this.#postProcess(value, env);
      const args = node.args.map((a) => this.#evaluateText(a.raw, env, offset + a.start, depth + 1).trim());
      return this.#postProcess(value(args), env);
    }

    const def = this.registry.get(node.name);
    if (!def) return node.raw;

    const flags = { preserveWhitespace: node.flags.includes('#') };
    const rawArgs = node.args.map((a) => a.raw);
    const args = def.delayArgResolution
      ? [...rawArgs]
      : node.args.map((a) => this.#evaluateText(a.raw, env, offset + a.start, depth + 1).trim());
    if (scoped) {
      rawArgs.push(scoped.content);
      if (def.delayArgResolution) {
        args.push(scoped.content);
      } else {
        const value = this.#evaluateText(scoped.content, env, offset + scoped.start, depth + 1);
        args.push(flags.preserveWhitespace ? value : trimScopedContent(value));
      }
    }
    if (args.length < (def.minArgs ?? 0)) return node.raw;

    let result: MacroResult;
    try {
      result = def.handler({
        name: node.name,
        args,
        rawArgs,
        isScoped: scoped !== null,
        flags,
        env,
        offset: offset + node.start,
        resolve: (t) => this.#evaluateText(t, env, offset + node.start, depth + 1),
        trimContent: trimScopedContent,
      });
    } catch {
      // As SillyTavern: a macro that cannot be evaluated stays as written.
      return node.raw;
    }
    return this.#postProcess(normalizeResult(result), env);
  }

  #postProcess(value: string, env: MacroEnv): string {
    if (!env.postProcess) return value;
    try {
      return env.postProcess(value);
    } catch {
      return value;
    }
  }

  #evaluateVariable(node: MacroNode, env: MacroEnv, offset: number, depth: number): string {
    const v = node.variable!;
    const scope: VariableScope | undefined = v.scope === 'local' ? env.localVariables : env.globalVariables;
    if (!scope) return '';
    let cached: string | undefined;
    const value = () => {
      cached ??= v.value
        ? this.#evaluateText(v.value.raw, env, offset + v.value.start, depth + 1).trim()
        : '';
      return cached;
    };
    const current = () => readVariablePath(scope, v.name);
    const numeric = (fn: (a: number, b: number) => boolean) => {
      const a = Number(current());
      const b = Number(value());
      return !Number.isNaN(a) && !Number.isNaN(b) && fn(a, b) ? 'true' : 'false';
    };
    switch (v.op) {
      case 'get':
        return stringifyValue(current());
      case 'set':
        scope.set(v.name, value());
        return '';
      case 'add':
        addVariable(scope, v.name, value());
        return '';
      case 'sub': {
        const n = Number(value());
        if (!Number.isNaN(n)) addVariable(scope, v.name, -n);
        return '';
      }
      case 'inc':
        return stringifyValue(addVariable(scope, v.name, 1));
      case 'dec':
        return stringifyValue(addVariable(scope, v.name, -1));
      case 'or':
        return isFalsyValue(current()) ? value() : stringifyValue(current());
      case 'nullish':
        return scope.has(v.name) ? stringifyValue(current()) : value();
      case 'orAssign':
        if (isFalsyValue(current())) {
          scope.set(v.name, value());
          return value();
        }
        return stringifyValue(current());
      case 'nullishAssign':
        if (!scope.has(v.name)) {
          scope.set(v.name, value());
          return value();
        }
        return stringifyValue(current());
      case 'eq':
        return stringifyValue(current()) === value() ? 'true' : 'false';
      case 'neq':
        return stringifyValue(current()) !== value() ? 'true' : 'false';
      case 'gt':
        return numeric((a, b) => a > b);
      case 'gte':
        return numeric((a, b) => a >= b);
      case 'lt':
        return numeric((a, b) => a < b);
      case 'lte':
        return numeric((a, b) => a <= b);
    }
  }
}
