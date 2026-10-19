/**
 * STscript execution (SillyTavern `SlashCommandClosure`, `SlashCommandScope`,
 * `SlashCommandExecutor`): closures hold commands and a scope of variables; executing one runs
 * its commands in order, each receiving the previous one's output (the pipe).
 */

import type { CommandDefinition } from './types.ts';

/** A value in the pipe or a variable: text, or a closure to run later. */
export type ScriptValue = string | Closure;
/** An unnamed argument after substitution: a value, or the parts around closures. */
export type UnnamedValue = ScriptValue | ScriptValue[];

export class ScriptAbortSignal {
  isQuiet = false;
  paused = false;
  aborted = false;
  reason: string | null = null;
}

/** Stops (or pauses) a running script (SillyTavern `SlashCommandAbortController`). */
export class ScriptAbortController {
  readonly signal = new ScriptAbortSignal();
  #listeners = new Set<() => void>();

  abort(reason = 'No reason.', isQuiet = false) {
    this.signal.isQuiet = isQuiet;
    this.signal.aborted = true;
    this.signal.reason = reason;
    for (const listener of this.#listeners) listener();
  }
  pause(reason = 'No reason.') {
    this.signal.paused = true;
    this.signal.reason = reason;
  }
  continue(reason = 'No reason.') {
    this.signal.paused = false;
    this.signal.reason = reason;
  }
  onAbort(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export class BreakController {
  isBreak = false;
  break() {
    this.isBreak = true;
  }
}

export class ClosureResult {
  interrupt = false;
  pipe: ScriptValue | undefined = undefined;
  isBreak = false;
  isAborted = false;
  isQuietlyAborted = false;
  abortReason = '';
  isError = false;
  errorMessage = '';
}

function lineOf(text: string, index: number) {
  return text.slice(0, index).replace(/[^\n]/g, '').length;
}

function columnOf(text: string, index: number) {
  return text.slice(0, index).split('\n').pop()!.length;
}

export class ScriptParserError extends Error {
  readonly text: string;
  readonly index: number;
  constructor(message: string, text: string, index: number) {
    super(message);
    this.text = text;
    this.index = index;
  }
  get line() {
    return lineOf(this.text, this.index);
  }
  get column() {
    return columnOf(this.text, this.index);
  }
}

export class ScriptExecutionError extends Error {
  readonly commandName: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  constructor(
    cause: unknown,
    message: string,
    commandName: string,
    start: number,
    end: number,
    text: string,
  ) {
    super(message, { cause });
    this.commandName = commandName;
    this.start = start;
    this.end = end;
    this.text = text;
  }
  get line() {
    return lineOf(this.text, this.start);
  }
  get column() {
    return columnOf(this.text, this.start);
  }
}

export class ScopeVariableExistsError extends Error {}
export class ScopeVariableNotFoundError extends Error {}

/** SillyTavern `convertValueType`: `as=` for indexed variable writes. */
export function convertValueType(value: unknown, type: unknown): unknown {
  if (value instanceof Closure || typeof type !== 'string') return value;
  const text = String(value);
  switch (type.trim().toLowerCase()) {
    case 'string':
    case 'str':
      return String(value);
    case 'null':
      return null;
    case 'undefined':
    case 'none':
      return undefined;
    case 'number':
      return Number(value);
    case 'int':
      return parseInt(text, 10);
    case 'float':
      return parseFloat(text);
    case 'boolean':
    case 'bool':
      return ['on', 'true', '1'].includes(text.trim().toLowerCase());
    case 'list':
    case 'array':
      try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    case 'object':
    case 'dict':
    case 'dictionary':
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    default:
      return value;
  }
}

/** Variables a value reads as: numbers for numeric text (SillyTavern `getVariable`). */
export function readValue(value: unknown): unknown {
  if (value instanceof Closure) return value;
  const trimmed = (value as { trim?: () => string })?.trim?.();
  return trimmed === '' || Number.isNaN(Number(value)) ? value || '' : Number(value);
}

/** Variables of a closure, with its parents' (SillyTavern `SlashCommandScope`). */
export class Scope {
  variableNames: string[] = [];
  variables: Record<string, unknown> = {};
  /** Values for `{{name}}` macros (`{{timesIndex}}`, Quick Reply `{{arg::...}}`). */
  macros: Record<string, ScriptValue | number> = {};
  #pipe: ScriptValue | undefined;
  parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  get pipe(): ScriptValue | undefined {
    return this.#pipe ?? this.parent?.pipe;
  }
  set pipe(value: ScriptValue | undefined) {
    this.#pipe = value;
  }

  get allVariableNames(): string[] {
    const names = [...this.variableNames, ...(this.parent?.allVariableNames ?? [])];
    return names.filter((name, i) => names.indexOf(name) === i);
  }

  get macroList(): { key: string; value: ScriptValue | number }[] {
    return [
      ...Object.keys(this.macros).map((key) => ({ key, value: this.macros[key]! })),
      ...(this.parent?.macroList ?? []),
    ];
  }

  getCopy(): Scope {
    const scope = new Scope(this.parent);
    scope.variableNames = [...this.variableNames];
    scope.variables = { ...this.variables };
    scope.macros = { ...this.macros };
    scope.#pipe = this.#pipe;
    return scope;
  }

  setMacro(key: string, value: ScriptValue | number, overwrite = true) {
    if (overwrite || !this.macroList.find((m) => m.key === key)) this.macros[key] = value;
  }

  existsVariableInScope(key: string) {
    return Object.hasOwn(this.variables, key);
  }
  existsVariable(key: string): boolean {
    return this.existsVariableInScope(key) || Boolean(this.parent?.existsVariable(key));
  }

  letVariable(key: string, value: unknown = undefined) {
    if (this.existsVariableInScope(key))
      throw new ScopeVariableExistsError(`Variable named "${key}" already exists.`);
    this.variables[key] = value;
  }

  setVariable(key: string, value: unknown, index: string | null = null, type: string | null = null): unknown {
    if (this.existsVariableInScope(key)) {
      if (index !== null && index !== undefined) {
        let v = this.variables[key] as Record<string, unknown> | string;
        try {
          const parsed = JSON.parse(v as string) as Record<string, unknown>;
          const numIndex = Number(index);
          parsed[Number.isNaN(numIndex) ? index : numIndex] = convertValueType(value, type);
          v = JSON.stringify(parsed);
        } catch {
          (v as unknown as Record<string, unknown>)[index] = convertValueType(value, type);
        }
        this.variables[key] = v;
      } else {
        this.variables[key] = value;
      }
      return value;
    }
    if (this.parent) return this.parent.setVariable(key, value, index, type);
    throw new ScopeVariableNotFoundError(`No such variable: "${key}"`);
  }

  getVariable(key: string, index: string | null = null): unknown {
    if (this.existsVariableInScope(key)) {
      if (index !== null && index !== undefined) {
        let v: unknown = this.variables[key];
        try {
          v = JSON.parse(v as string);
        } catch {
          // not JSON
        }
        const numIndex = Number(index);
        v = (v as Record<string, unknown>)?.[Number.isNaN(numIndex) ? index : numIndex];
        if (typeof v === 'object' && v !== null) return JSON.stringify(v);
        return v ?? '';
      }
      return readValue(this.variables[key]);
    }
    if (this.parent) return this.parent.getVariable(key, index);
    throw new ScopeVariableNotFoundError(`No such variable: "${key}"`);
  }
}

export interface NamedAssignment {
  name: string;
  value: ScriptValue | undefined;
  start: number;
  end: number;
}

export interface UnnamedAssignment {
  value: ScriptValue | undefined;
  start: number;
  end: number;
}

/** One command call in a closure (SillyTavern `SlashCommandExecutor`). */
export class Executor {
  injectPipe = true;
  name = '';
  end = 0;
  command: CommandDefinition | undefined;
  namedArgumentList: NamedAssignment[] = [];
  unnamedArgumentList: UnnamedAssignment[] = [];
  parserFlags: Record<number, boolean> = {};
  start: number;
  constructor(start: number) {
    this.start = start;
  }
}

/** `/break`: leaves the loop or `/run` closure it is in. */
export class BreakExecutor extends Executor {}
/** `/breakpoint`: a stop for the debugger (no-op without one). */
export class BreakPointExecutor extends Executor {}

/** What closures need from their runtime: macro substitution with the script's extra macros. */
export interface ClosureHost {
  /**
   * Expands macros in `text`. `dynamic` holds `{{pipe}}`, `{{var::name}}` and the scope's own
   * macros; a dynamic macro may return a closure, which is put back in place of the text.
   */
  substitute(text: string, dynamic: Record<string, (args: string[]) => string>): string;
}

/** Arguments a command receives: named ones by name, plus the execution context. */
export interface NamedArguments {
  [name: string]: unknown;
  _scope: Scope;
  _parserFlags: Record<number, boolean>;
  _abortController: ScriptAbortController | null;
  _hasUnnamedArgument: boolean;
}

const CLOSURE_BOUNDARY = '￰~CLOSURE~￰';

let nextClosureKey = 1;

const unescape = (value: string) => value.replace(/\\\{/g, '{').replace(/\\\}/g, '}');

export class Closure {
  scope: Scope;
  executeNow = false;
  /** Named arguments the closure declares (`{: a=1 b=2 /echo ... :}`). */
  argumentList: NamedAssignment[] = [];
  /** Arguments passed by the caller (`/run closure a=3`). */
  providedArgumentList: NamedAssignment[] = [];
  executorList: Executor[] = [];
  abortController: ScriptAbortController | null = null;
  breakController: BreakController | null = null;
  onProgress: ((done: number, total: number) => void) | null = null;
  rawText = '';
  fullText = '';
  host: ClosureHost;

  constructor(parent: Scope | null, host: ClosureHost) {
    this.scope = new Scope(parent);
    this.host = host;
  }

  toString() {
    return `[Closure]${this.executeNow ? '()' : ''}`;
  }

  get commandCount(): number {
    let count = 0;
    for (const executor of this.executorList) {
      count += 1;
      for (const arg of [...executor.namedArgumentList, ...executor.unnamedArgumentList]) {
        if (arg.value instanceof Closure) count += arg.value.commandCount;
      }
    }
    return count;
  }

  getCopy(): Closure {
    const closure = new Closure(null, this.host);
    closure.scope = this.scope.getCopy();
    closure.executeNow = this.executeNow;
    closure.argumentList = this.argumentList;
    closure.providedArgumentList = this.providedArgumentList;
    closure.executorList = this.executorList;
    closure.abortController = this.abortController;
    closure.breakController = this.breakController;
    closure.rawText = this.rawText;
    closure.fullText = this.fullText;
    closure.onProgress = this.onProgress;
    return closure;
  }

  /** Adopts a closure found in an argument or macro: it runs within this one. */
  #adopt(closure: Closure) {
    closure.abortController = this.abortController;
    closure.breakController = this.breakController;
    closure.scope.parent = this.scope;
  }

  /**
   * Expands `{{pipe}}`, `{{var::name::index}}`, the scope's macros and every regular macro
   * (SillyTavern `substituteWithMacroEngine`). Scope macros holding closures split the result.
   */
  substituteParams(text: string, scope: Scope = this.scope): ScriptValue | ScriptValue[] {
    const closures = new Map<string, Closure>();
    const dynamic: Record<string, (args: string[]) => string> = {
      pipe: () => {
        const pipe = scope.pipe;
        return pipe === undefined ? '' : String(pipe);
      },
      var: (args) => {
        try {
          return String(scope.getVariable(args[0] ?? '', args[1] ?? null) ?? '');
        } catch {
          return '';
        }
      },
    };
    const custom = new Map<string, { args: string[]; value: ScriptValue | number }[]>();
    for (const macro of scope.macroList) {
      const [name, ...rest] = macro.key.split('::');
      if (!custom.has(name!)) custom.set(name!, []);
      custom.get(name!)!.push({ args: rest, value: macro.value });
    }
    for (const [name, definitions] of custom) {
      dynamic[name] = (args) => {
        const sorted = definitions.toSorted(
          (a, b) => Number(a.args.includes('*')) - Number(b.args.includes('*')),
        );
        const match = sorted.find(
          (d) => d.args.length === args.length && d.args.every((arg, i) => arg === '*' || arg === args[i]),
        )?.value;
        if (match instanceof Closure) {
          this.#adopt(match);
          const key = `c${nextClosureKey++}`;
          closures.set(key, match);
          return `${CLOSURE_BOUNDARY}${key}${CLOSURE_BOUNDARY}`;
        }
        return String(match ?? '');
      };
    }
    const result = this.host.substitute(text, dynamic);
    if (!closures.size) return result;
    const parts = result
      .split(CLOSURE_BOUNDARY)
      .map((part) => closures.get(part) ?? part)
      .filter(Boolean);
    return parts.length === 1 ? parts[0]! : parts;
  }

  async execute(): Promise<ClosureResult> {
    // A copy runs, so that running a closure again (loops, /run) starts from a clean scope.
    return this.getCopy().executeDirect();
  }

  async executeDirect(): Promise<ClosureResult> {
    for (const arg of this.argumentList) {
      let v: unknown = arg.value;
      if (v instanceof Closure) {
        v.scope.parent = this.scope;
        v.breakController = this.breakController;
        v = v.executeNow ? (await v.execute()).pipe : v;
      } else {
        v = this.substituteParams(String(v ?? ''));
      }
      if (typeof v === 'string') v = unescape(v);
      this.scope.letVariable(arg.name, v);
    }
    for (const arg of this.providedArgumentList) {
      let v: unknown = arg.value;
      if (v instanceof Closure) {
        v.scope.parent = this.scope;
        v.breakController = this.breakController;
        v = v.executeNow ? (await v.execute()).pipe : v;
      } else {
        v = this.substituteParams(String(v ?? ''), this.scope.parent ?? this.scope);
      }
      if (typeof v === 'string') v = unescape(v);
      this.scope.setVariable(arg.name, v);
    }
    if (this.executorList.length === 0) this.scope.pipe = '';

    let done = 0;
    let isFirst = true;
    for (const executor of this.executorList) {
      if (this.breakController?.isBreak) break;
      this.onProgress?.(done, this.commandCount);
      const args: NamedArguments = {
        _scope: this.scope,
        _parserFlags: executor.parserFlags,
        _abortController: this.abortController,
        _hasUnnamedArgument: executor.unnamedArgumentList.length > 0,
      };
      if (executor instanceof BreakPointExecutor) {
        done++;
      } else if (executor instanceof BreakExecutor) {
        const value = await this.substituteUnnamedArgument(executor, isFirst, args);
        done += this.executorList.length - this.executorList.indexOf(executor);
        this.scope.pipe = (Array.isArray(value) ? value.join('') : value) ?? this.scope.pipe;
        if (this.breakController) {
          this.breakController.break();
          break;
        }
      } else {
        await this.substituteNamedArguments(executor, args);
        const value = await this.substituteUnnamedArgument(executor, isFirst, args);
        let aborted = await this.#testAbort();
        if (aborted) return aborted;
        try {
          const command = executor.command;
          this.scope.pipe = command?.callback
            ? ((await command.callback(args, value ?? '')) as ScriptValue)
            : '';
        } catch (error) {
          throw new ScriptExecutionError(
            error,
            (error as Error)?.message ?? String(error),
            executor.name,
            executor.start,
            executor.end,
            this.fullText,
          );
        }
        this.#lintPipe();
        done += 1;
        this.onProgress?.(done, this.commandCount);
        aborted = await this.#testAbort();
        if (aborted) return aborted;
      }
      isFirst = false;
    }
    const result = new ClosureResult();
    result.pipe = this.scope.pipe;
    result.isBreak = this.breakController?.isBreak ?? false;
    return result;
  }

  async #testAbort(): Promise<ClosureResult | undefined> {
    const signal = this.abortController?.signal;
    while (signal && !signal.aborted && signal.paused) await new Promise((r) => setTimeout(r, 200));
    if (signal?.aborted) {
      const result = new ClosureResult();
      result.isAborted = true;
      result.isQuietlyAborted = signal.isQuiet;
      result.abortReason = String(signal.reason);
      return result;
    }
    return undefined;
  }

  async substituteNamedArguments(executor: Executor, args: NamedArguments) {
    const assign = (name: string, value: unknown): void => {
      if (Array.isArray(value)) {
        for (const v of value) assign(name, v);
        return;
      }
      const definition = executor.command?.namedArgumentList?.find((x) => x.name === name);
      name = definition?.name ?? name;
      if (value && typeof value === 'string') value = unescape(value);
      if (definition?.acceptsMultiple) {
        const current = args[name];
        args[name] =
          current === undefined ? [value] : [...(Array.isArray(current) ? current : [current]), value];
      } else {
        args[name] = value;
      }
    };
    for (const arg of executor.namedArgumentList) {
      if (arg.value instanceof Closure) {
        const closure = arg.value;
        closure.scope.parent = this.scope;
        closure.breakController = this.breakController;
        assign(arg.name, closure.executeNow ? (await closure.execute()).pipe : closure);
      } else {
        assign(arg.name, this.substituteParams(String(arg.value ?? '')));
      }
    }
  }

  async substituteUnnamedArgument(
    executor: Executor,
    isFirst: boolean,
    args: NamedArguments,
  ): Promise<UnnamedValue> {
    let value: unknown;
    const split = executor.command?.splitUnnamedArgument ?? false;
    if (executor.unnamedArgumentList.length === 0) {
      if (!isFirst && executor.injectPipe) {
        value = this.scope.pipe;
        args._hasUnnamedArgument = this.scope.pipe !== null && this.scope.pipe !== undefined;
      }
    } else {
      const parts: unknown[] = [];
      for (const assignment of executor.unnamedArgumentList) {
        let v: unknown = assignment.value;
        if (v instanceof Closure) {
          v.scope.parent = this.scope;
          v.breakController = this.breakController;
          v = v.executeNow ? (await v.execute()).pipe : v;
        } else {
          v = this.substituteParams(String(v ?? ''));
        }
        parts.push(v);
      }
      value = parts;
      if (!split) {
        if (parts.length === 1) value = parts[0];
        else if (!parts.some((p) => p instanceof Closure)) value = parts.join('');
      }
    }
    if (typeof value === 'string') value = unescape(value);
    else if (Array.isArray(value)) value = value.map((v) => (typeof v === 'string' ? unescape(v) : v));
    value ??= '';
    if (split && !Array.isArray(value)) value = [value];
    return value as UnnamedValue;
  }

  /** Non-text results become JSON, missing ones empty text (SillyTavern `#lintPipe`). */
  #lintPipe() {
    const pipe = this.scope.pipe as unknown;
    if (pipe === undefined || pipe === null) this.scope.pipe = '';
    else if (!(typeof pipe === 'string' || pipe instanceof Closure))
      this.scope.pipe = JSON.stringify(pipe) ?? '';
  }
}
