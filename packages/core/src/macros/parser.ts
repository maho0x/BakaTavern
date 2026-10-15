/**
 * Parser for SillyTavern "Macros 2.0" syntax:
 *
 * - `{{name}}`, `{{name::a::b}}`, `{{name:single arg}}`, `{{name single arg}}`
 * - nested macros inside arguments: `{{setvar::x::{{char}}}}`
 * - scoped blocks: `{{if cond}}...{{else}}...{{/if}}` (pairing happens in the engine)
 * - comments: `{{// note}}` and scoped `{{//}}...{{///}}`
 * - flags before the name: `#` preserve whitespace, `/` closing tag (also `! ? ~ >`)
 * - variable shorthands: `{{.local}}`, `{{$global}}`, with `= += -= ++ -- ?? ??= || ||= == != > >= < <=`
 */

export interface TextNode {
  type: 'text';
  value: string;
  start: number;
  end: number;
}

export type VarOp =
  | 'get'
  | 'set'
  | 'add'
  | 'sub'
  | 'inc'
  | 'dec'
  | 'or'
  | 'orAssign'
  | 'nullish'
  | 'nullishAssign'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface MacroArg {
  /** Trimmed raw text of the argument (may contain nested macros). */
  raw: string;
  /** Offset of `raw` in the source text. */
  start: number;
}

export interface MacroNode {
  type: 'macro';
  /** Offsets of the whole `{{...}}` in the source text, `end` exclusive. */
  start: number;
  end: number;
  raw: string;
  flags: string;
  closing: boolean;
  kind: 'call' | 'variable';
  /** Macro name as written (`//` for comments). */
  name: string;
  args: MacroArg[];
  variable?: { scope: 'local' | 'global'; name: string; op: VarOp; value: MacroArg | null };
}

export type MacroAstNode = TextNode | MacroNode;

const IDENT = /^[a-zA-Z][\w-]*/;
const VAR_IDENT = /^[a-zA-Z](?:[\w-]*\w)?/;
const FLAG_CHARS = '!?~#/>';

const VAR_OPS: [string, VarOp][] = [
  ['++', 'inc'],
  ['--', 'dec'],
  ['??=', 'nullishAssign'],
  ['??', 'nullish'],
  ['||=', 'orAssign'],
  ['||', 'or'],
  ['-=', 'sub'],
  ['==', 'eq'],
  ['!=', 'neq'],
  ['>=', 'gte'],
  ['>', 'gt'],
  ['<=', 'lte'],
  ['<', 'lt'],
  ['+=', 'add'],
  ['=', 'set'],
];

/** Index just past the `}}` matching the `{{` at `start`, honouring nesting; -1 if unclosed. */
function findMacroEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++;
      i += 2;
      continue;
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

/** Splits on `::` that are not inside a nested macro. */
function splitTopLevel(text: string, offset: number): MacroArg[] {
  const parts: MacroArg[] = [];
  let depth = 0;
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++;
      i++;
    } else if (text[i] === '}' && text[i + 1] === '}' && depth > 0) {
      depth--;
      i++;
    } else if (depth === 0 && text[i] === ':' && text[i + 1] === ':') {
      parts.push(trimmedArg(text.slice(segStart, i), offset + segStart));
      segStart = i + 2;
      i++;
    }
  }
  parts.push(trimmedArg(text.slice(segStart), offset + segStart));
  return parts;
}

function trimmedArg(raw: string, start: number): MacroArg {
  const lead = raw.length - raw.trimStart().length;
  return { raw: raw.trim(), start: start + lead };
}

/** Parses the inside of one `{{...}}`; returns null for text that is not a valid macro. */
function parseInner(
  inner: string,
  innerStart: number,
): Omit<MacroNode, 'type' | 'start' | 'end' | 'raw'> | null {
  let pos = 0;
  const skipWs = () => {
    while (pos < inner.length && /\s/.test(inner[pos]!)) pos++;
  };
  skipWs();

  // Comments: `{{// text}}`; `{{///}}` closes a scoped `{{//}}`.
  if (inner.startsWith('//', pos)) {
    const rest = inner.slice(pos + 2);
    const closing = rest.startsWith('/') && rest.slice(1).trim() === '';
    return {
      flags: closing ? '/' : '',
      closing,
      kind: 'call',
      name: '//',
      args: closing || rest.trim() === '' ? [] : [trimmedArg(rest, innerStart + pos + 2)],
    };
  }

  let flags = '';
  while (pos < inner.length) {
    const ch = inner[pos]!;
    if (ch === '.' || ch === '$') break;
    if (FLAG_CHARS.includes(ch)) {
      flags += ch;
      pos++;
    } else if (/\s/.test(ch)) {
      pos++;
    } else {
      break;
    }
  }

  const prefix = inner[pos];
  if (prefix === '.' || prefix === '$') {
    pos++;
    skipWs();
    const m = VAR_IDENT.exec(inner.slice(pos));
    if (!m) return null;
    const name = m[0];
    pos += name.length;
    skipWs();
    let op: VarOp = 'get';
    let value: MacroArg | null = null;
    for (const [token, kind] of VAR_OPS) {
      if (inner.startsWith(token, pos)) {
        op = kind;
        pos += token.length;
        if (kind !== 'inc' && kind !== 'dec') {
          value = trimmedArg(inner.slice(pos), innerStart + pos);
          pos = inner.length;
        }
        break;
      }
    }
    if (inner.slice(pos).trim() !== '') return null;
    return {
      flags,
      closing: false,
      kind: 'variable',
      name,
      args: [],
      variable: { scope: prefix === '.' ? 'local' : 'global', name, op, value },
    };
  }

  const m = IDENT.exec(inner.slice(pos));
  if (!m) return null;
  const name = m[0];
  pos += name.length;
  const rest = inner.slice(pos);
  const restStart = innerStart + pos;
  let args: MacroArg[] = [];
  if (rest.trim() !== '') {
    const first = rest[0]!;
    if (!/\s/.test(first) && first !== ':') return null;
    const lead = rest.length - rest.trimStart().length;
    const body = rest.slice(lead);
    if (body.startsWith('::')) {
      args = splitTopLevel(body.slice(2), restStart + lead + 2);
    } else if (body.startsWith(':')) {
      args = [trimmedArg(body.slice(1), restStart + lead + 1)];
    } else {
      args = [trimmedArg(body, restStart + lead)];
    }
  }
  return { flags, closing: flags.includes('/'), kind: 'call', name, args };
}

/** Splits text into plain text and macro nodes (one level; nested macros stay inside args). */
export function parseMacros(text: string): MacroAstNode[] {
  const nodes: MacroAstNode[] = [];
  let cursor = 0;
  let textStart = 0;
  const pushText = (end: number) => {
    if (end > textStart)
      nodes.push({ type: 'text', value: text.slice(textStart, end), start: textStart, end });
  };
  while (cursor < text.length) {
    let open = text.indexOf('{{', cursor);
    if (open < 0) break;
    // In `{{{x}}}` the first brace is literal text.
    while (text[open + 2] === '{') open++;
    const end = findMacroEnd(text, open);
    if (end < 0) break;
    const parsed = parseInner(text.slice(open + 2, end - 2), open + 2);
    if (!parsed) {
      cursor = open + 2;
      continue;
    }
    pushText(open);
    nodes.push({ type: 'macro', start: open, end, raw: text.slice(open, end), ...parsed });
    cursor = end;
    textStart = end;
  }
  pushText(text.length);
  return nodes;
}
