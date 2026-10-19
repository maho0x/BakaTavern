/**
 * STscript parser (port of SillyTavern 1.19 `SlashCommandParser`, without the editor features:
 * autocomplete, syntax highlighting and the macro index).
 */

import { isFalseBoolean, isTrueBoolean } from '../util/text.ts';
import type { Scope } from './closure.ts';
import {
  BreakExecutor,
  BreakPointExecutor,
  Closure,
  Executor,
  ScriptParserError,
  type ClosureHost,
  type NamedAssignment,
  type ScriptAbortController,
  type UnnamedAssignment,
} from './closure.ts';
import type { CommandDefinition } from './types.ts';

export const ParserFlag = { STRICT_ESCAPING: 1, REPLACE_GETVAR: 2 } as const;

export type ParserFlags = Partial<Record<number, boolean>>;

/** Names a command may not start with: they are syntax. */
export const RESERVED_COMMAND_STARTS = ['/', '#', ':', 'parser-flag', 'breakpoint'];

export class Parser {
  text = '';
  index = 0;
  flags: Record<number, boolean> = {};
  verifyCommandNames = true;
  jumpedEscapeSequence = false;
  scope: Scope | null = null;
  closure: Closure | null = null;
  abortController: ScriptAbortController | null = null;

  readonly lookup: (name: string) => CommandDefinition | undefined;
  readonly host: ClosureHost;

  constructor(lookup: (name: string) => CommandDefinition | undefined, host: ClosureHost) {
    this.lookup = lookup;
    this.host = host;
  }

  get ahead() {
    return this.text.slice(this.index + 1);
  }
  get behind() {
    return this.text.slice(0, this.index);
  }
  get char() {
    return this.text[this.index] ?? '';
  }
  get endOfText() {
    return this.index >= this.text.length || (/\s/.test(this.char) && /^\s+$/.test(this.ahead));
  }

  parse(
    text: string,
    verifyCommandNames = true,
    flags: ParserFlags | null = null,
    abortController: ScriptAbortController | null = null,
  ): Closure {
    this.verifyCommandNames = verifyCommandNames;
    for (const flag of Object.values(ParserFlag)) this.flags[flag] = flags?.[flag] ?? false;
    this.abortController = abortController;
    this.text = text;
    this.index = 0;
    this.scope = null;
    this.closure = null;
    return this.parseClosure(true);
  }

  take(length = 1): string {
    this.jumpedEscapeSequence = false;
    let content = this.char;
    this.index++;
    if (length > 1) content = this.take(length - 1);
    return content;
  }

  discardWhitespace() {
    while (/\s/.test(this.char)) {
      this.take();
      this.jumpedEscapeSequence = false;
    }
  }

  /**
   * Whether the next characters are `sequence`. A backslash before it escapes it: the index then
   * moves past the backslash and the symbol counts as text.
   */
  testSymbol(sequence: string | RegExp, offset = 0): boolean {
    if (!this.flags[ParserFlag.STRICT_ESCAPING]) return this.testSymbolLoose(sequence, offset);
    const escapeOffset = this.jumpedEscapeSequence ? -1 : 0;
    const escapes = /^(\\*)/.exec(this.text.slice(this.index + offset + escapeOffset))![1]!.length;
    const test =
      sequence instanceof RegExp
        ? (text: string) => new RegExp(`^${sequence.source}`).test(text)
        : (text: string) => text.startsWith(sequence);
    if (test(this.text.slice(this.index + offset + escapeOffset + escapes))) {
      if (escapes === 0) return true;
      if (!this.jumpedEscapeSequence && offset === 0) {
        this.index++;
        this.jumpedEscapeSequence = true;
      }
      return false;
    }
    return false;
  }

  testSymbolLoose(sequence: string | RegExp, offset = 0): boolean {
    const escapeOffset = this.jumpedEscapeSequence ? -1 : 0;
    const escapes = this.text[this.index + offset + escapeOffset] === '\\' ? 1 : 0;
    const test =
      sequence instanceof RegExp
        ? (text: string) => new RegExp(`^${sequence.source}`).test(text)
        : (text: string) => text.startsWith(sequence);
    if (test(this.text.slice(this.index + offset + escapeOffset + escapes))) {
      if (escapes === 0) return true;
      if (!this.jumpedEscapeSequence && offset === 0) {
        this.index++;
        this.jumpedEscapeSequence = true;
      }
      return false;
    }
    return false;
  }

  testClosure() {
    return this.testSymbol('{:');
  }

  testClosureEnd() {
    if (!this.scope?.parent) {
      // The root closure has no {: :}.
      return this.index >= this.text.length;
    }
    if (!this.verifyCommandNames) {
      if (this.index >= this.text.length) return true;
    } else if (this.ahead.length < 1) {
      throw new ScriptParserError(`Unclosed closure at position ${this.index}`, this.text, this.index);
    }
    return this.testSymbol(':}');
  }

  parseClosure(isRoot = false): Closure {
    let injectPipe = true;
    if (!isRoot) this.take(2); // {:
    const textStart = this.index;
    const closure = new Closure(this.scope, this.host);
    closure.fullText = this.text;
    closure.abortController = this.abortController;
    this.scope = closure.scope;
    const outer = this.closure;
    this.closure = closure;
    this.discardWhitespace();
    while (this.testNamedArgument()) {
      const arg = this.parseNamedArgument();
      closure.argumentList.push(arg);
      this.scope.variableNames.push(arg.name);
      this.discardWhitespace();
    }
    while (!this.testClosureEnd()) {
      if (this.testBlockComment()) {
        this.parseBlockComment();
      } else if (this.testComment()) {
        this.parseComment();
      } else if (this.testParserFlag()) {
        this.parseParserFlag();
      } else if (this.testRunShorthand()) {
        closure.executorList.push(this.parseRunShorthand());
        injectPipe = true;
      } else if (this.testBreakPoint()) {
        // Only a debugger stops there.
        this.parseBreakPoint();
      } else if (this.testBreak()) {
        closure.executorList.push(this.parseBreak());
      } else if (this.testCommand()) {
        const cmd = this.parseCommand();
        cmd.injectPipe = injectPipe;
        closure.executorList.push(cmd);
        injectPipe = true;
      } else {
        while (!this.testCommandEnd()) this.take(); // plain text between commands
      }
      this.discardWhitespace();
      // One pipe ends the command; a second one keeps the pipe from the next command.
      if (this.testSymbol('|')) {
        this.take();
        if (this.testSymbol('|')) {
          injectPipe = false;
          this.take();
        }
      }
      this.discardWhitespace();
    }
    closure.rawText = this.text.slice(textStart, this.index);
    if (!isRoot) this.take(2); // :}
    if (this.testSymbol('()')) {
      this.take(2);
      closure.executeNow = true;
    }
    this.scope = closure.scope.parent;
    this.closure = outer ?? closure;
    return closure;
  }

  testBreakPoint() {
    return this.testSymbol(/\/breakpoint\s*\|/);
  }
  parseBreakPoint() {
    const cmd = new BreakPointExecutor(this.index + 1);
    cmd.name = 'breakpoint';
    cmd.command = this.lookup('breakpoint');
    this.take('/breakpoint'.length);
    cmd.end = this.index;
    return cmd;
  }

  testBreak() {
    return this.testSymbol(/\/break(\s|\||$)/);
  }
  parseBreak() {
    const cmd = new BreakExecutor(this.index + 1);
    cmd.name = 'break';
    cmd.command = this.lookup('break');
    this.take('/break'.length);
    this.discardWhitespace();
    if (this.testUnnamedArgument()) cmd.unnamedArgumentList.push(...this.parseUnnamedArgument(false));
    cmd.end = this.index;
    return cmd;
  }

  testBlockComment() {
    return this.testSymbol('/*');
  }
  testBlockCommentEnd() {
    if (!this.verifyCommandNames) {
      if (this.index >= this.text.length) return true;
    } else if (this.ahead.length < 1) {
      throw new ScriptParserError(`Unclosed block comment at position ${this.index}`, this.text, this.index);
    }
    return this.testSymbol('*|');
  }
  parseBlockComment() {
    this.take(2); // /*
    while (!this.testBlockCommentEnd()) {
      if (this.testBlockComment()) this.parseBlockComment();
      this.take();
    }
    this.take(2); // *|
  }

  testComment() {
    return this.testSymbol(/\/[/#]/);
  }
  testCommentEnd() {
    if (!this.verifyCommandNames) {
      if (this.index >= this.text.length) return true;
    } else if (this.endOfText) {
      throw new ScriptParserError(`Unclosed comment at position ${this.index}`, this.text, this.index);
    }
    return this.testSymbol('|');
  }
  parseComment() {
    this.take(2); // // or /#
    while (!this.testCommentEnd()) this.take();
  }

  testParserFlag() {
    return this.testSymbol('/parser-flag ');
  }
  parseParserFlag() {
    this.take(13);
    const [flag, state] = this.parseUnnamedArgument(true);
    const name = String(flag?.value ?? '');
    if (Object.hasOwn(ParserFlag, name)) {
      this.flags[ParserFlag[name as keyof typeof ParserFlag]] = isTrueBoolean(String(state?.value ?? 'on'));
    }
  }

  testRunShorthand() {
    return this.testSymbol('/:') && !this.testSymbol(':}', 1);
  }
  parseRunShorthand(): Executor {
    const cmd = new Executor(this.index + 2);
    cmd.name = ':';
    cmd.command = this.lookup('run');
    this.take(2);
    const assignment: UnnamedAssignment = { value: undefined, start: this.index, end: this.index };
    assignment.value = this.testQuotedValue() ? this.parseQuotedValue() : this.parseValue();
    assignment.end = this.index;
    cmd.unnamedArgumentList = [assignment];
    this.discardWhitespace();
    while (this.testNamedArgument()) {
      cmd.namedArgumentList.push(this.parseNamedArgument());
      this.discardWhitespace();
    }
    this.discardWhitespace();
    if (this.testCommandEnd()) {
      cmd.end = this.index;
      return cmd;
    }
    throw new ScriptParserError(
      `Unexpected end of command at position ${this.index}: "/${cmd.name}"`,
      this.text,
      this.index,
    );
  }

  testCommand() {
    return this.testSymbol('/');
  }
  testCommandEnd(): boolean {
    if (this.testClosureEnd()) return true;
    // A pipe inside {{macro}} braces does not end the command.
    return this.testSymbol('|') && !this.isInsideMacroBraces();
  }

  isInsideMacroBraces() {
    const behind = this.behind;
    let depth = 0;
    for (let i = 0; i < behind.length; i++) {
      if (behind[i] === '{' && behind[i + 1] === '{') {
        depth++;
        i++;
      } else if (behind[i] === '}' && behind[i + 1] === '}') {
        depth = Math.max(0, depth - 1);
        i++;
      }
    }
    return depth > 0;
  }

  parseCommand(): Executor {
    const cmd = new Executor(this.index + 1);
    cmd.parserFlags = { ...this.flags };
    this.take(); // /
    while (!/\s/.test(this.char) && !this.testCommandEnd()) cmd.name += this.take();
    this.discardWhitespace();
    const command = this.lookup(cmd.name);
    if (this.verifyCommandNames && !command) {
      throw new ScriptParserError(
        `Unknown command at position ${this.index - cmd.name.length}: "/${cmd.name}"`,
        this.text,
        this.index - cmd.name.length,
      );
    }
    cmd.command = command;
    while (this.testNamedArgument()) {
      cmd.namedArgumentList.push(this.parseNamedArgument());
      this.discardWhitespace();
    }
    this.discardWhitespace();
    if (this.testUnnamedArgument()) {
      const rawArg = cmd.namedArgumentList.find((a) => a.name === 'raw');
      const rawQuotes =
        command?.rawQuotes && rawArg
          ? !isFalseBoolean(String(rawArg.value ?? ''))
          : Boolean(command?.rawQuotes);
      cmd.unnamedArgumentList = this.parseUnnamedArgument(
        Boolean(command?.unnamedArgumentList?.length && command.splitUnnamedArgument),
        command?.splitUnnamedArgumentCount ?? null,
        rawQuotes,
      );
      if (cmd.name === 'let') {
        const key = cmd.namedArgumentList.find((a) => a.name === 'key');
        if (key) this.scope!.variableNames.push(String(key.value));
        else if (typeof cmd.unnamedArgumentList[0]?.value === 'string')
          this.scope!.variableNames.push(cmd.unnamedArgumentList[0].value);
      } else if (cmd.name === 'import') {
        const names = cmd.unnamedArgumentList.map((a) => String(a.value));
        for (let i = 0; i < names.length; i++) {
          let destination = names[i]!;
          if (i + 2 < names.length && names[i + 1] === 'as') {
            destination = names[i + 2]!;
            i += 2;
          }
          this.scope!.variableNames.push(destination);
        }
      }
    }
    if (this.testCommandEnd()) {
      cmd.end = this.index;
      return cmd;
    }
    throw new ScriptParserError(
      `Unexpected end of command at position ${this.index}: "/${cmd.name}"`,
      this.text,
      this.index,
    );
  }

  testNamedArgument() {
    return /^(\w+)=/.test(`${this.char}${this.ahead}`);
  }

  parseNamedArgument(): NamedAssignment {
    const assignment: NamedAssignment = { name: '', value: undefined, start: this.index, end: this.index };
    let key = '';
    while (/\w/.test(this.char)) key += this.take();
    this.take(); // =
    assignment.name = key;
    if (this.testClosure()) assignment.value = this.parseClosure();
    else if (this.testQuotedValue()) assignment.value = this.parseQuotedValue();
    else if (this.testListValue()) assignment.value = this.parseListValue();
    else if (this.testValue()) assignment.value = this.parseValue();
    assignment.end = this.index;
    return assignment;
  }

  testUnnamedArgument() {
    return !this.testCommandEnd();
  }

  parseUnnamedArgument(
    split: boolean,
    splitCount: number | null = null,
    rawQuotes = false,
  ): UnnamedAssignment[] {
    const wasSplit = split;
    let value = this.jumpedEscapeSequence ? this.take() : '';
    let isList = split;
    let listValues: UnnamedAssignment[] = [];
    const listQuoted: boolean[] = [];
    const fresh = (): UnnamedAssignment => ({ value: undefined, start: this.index, end: this.index });
    let assignment = fresh();
    if (!split && !rawQuotes && this.testQuotedValue()) {
      // A quoted start: the whole quoted value, then whatever follows.
      assignment.value = this.parseQuotedValue();
      assignment.end = this.index;
      isList = true;
      listValues.push(assignment);
      listQuoted.push(true);
      assignment = fresh();
    }
    while (!this.testCommandEnd()) {
      if (split && splitCount && listValues.length >= splitCount) {
        // The split count is reached: the rest is one value.
        split = false;
        if (this.testQuotedValue()) {
          assignment.value = this.parseQuotedValue();
          assignment.end = this.index;
          listValues.push(assignment);
          listQuoted.push(true);
          assignment = fresh();
        }
      }
      if (this.testClosure()) {
        isList = true;
        if (value.length > 0) {
          assignment.value = value;
          listValues.push(assignment);
          listQuoted.push(false);
          assignment = fresh();
          if (!split && this.testQuotedValue()) {
            assignment.value = this.parseQuotedValue();
            assignment.end = this.index;
            listValues.push(assignment);
            listQuoted.push(true);
            assignment = fresh();
          } else {
            value = '';
          }
        }
        assignment.start = this.index;
        assignment.value = this.parseClosure();
        assignment.end = this.index;
        listValues.push(assignment);
        // (SillyTavern does not record whether a closure was quoted.)
        assignment = fresh();
        if (split) this.discardWhitespace();
      } else if (split) {
        if (this.testQuotedValue()) {
          assignment.start = this.index;
          assignment.value = this.parseQuotedValue();
          assignment.end = this.index;
          listValues.push(assignment);
          listQuoted.push(true);
          assignment = fresh();
        } else if (this.testListValue()) {
          assignment.start = this.index;
          assignment.value = this.parseListValue();
          assignment.end = this.index;
          listValues.push(assignment);
          listQuoted.push(false);
          assignment = fresh();
        } else if (this.testValue()) {
          assignment.start = this.index;
          assignment.value = this.parseValue();
          assignment.end = this.index;
          listValues.push(assignment);
          listQuoted.push(false);
          assignment = fresh();
        } else {
          throw new ScriptParserError(
            `Unexpected end of unnamed argument at index ${this.index}.`,
            this.text,
            this.index,
          );
        }
        this.discardWhitespace();
      } else {
        value += this.take();
        assignment.end = this.index;
      }
    }
    if (isList && value.length > 0) {
      assignment.value = value;
      listValues.push(assignment);
      listQuoted.push(false);
    }
    if (isList) {
      const first = listValues[0];
      if (typeof first?.value === 'string') {
        if (!listQuoted[0]) first.value = first.value.trimStart();
        if (first.value.length === 0) {
          listValues.shift();
          listQuoted.shift();
        }
      }
      const last = listValues.at(-1);
      if (typeof last?.value === 'string') {
        if (!listQuoted.at(-1)) last.value = last.value.trimEnd();
        if (last.value.length === 0) {
          listValues.pop();
          listQuoted.pop();
        }
      }
      if (wasSplit && splitCount && splitCount + 1 < listValues.length) {
        // Quoting plus more text after the split count: join the rest, quotes restored.
        let joined = '';
        for (let i = splitCount; i < listValues.length; i++) {
          joined += listQuoted[i] ? `"${String(listValues[i]!.value)}"` : String(listValues[i]!.value);
        }
        listValues = [
          ...listValues.slice(0, splitCount),
          { value: joined, start: listValues[splitCount]!.start, end: listValues.at(-1)!.end },
        ];
      }
      return listValues;
    }
    assignment.value = value.trim();
    return [assignment];
  }

  testQuotedValue() {
    return this.testSymbol('"');
  }
  testQuotedValueEnd() {
    if (this.endOfText) {
      if (this.verifyCommandNames)
        throw new ScriptParserError(
          `Unexpected end of quoted value at position ${this.index}`,
          this.text,
          this.index,
        );
      return true;
    }
    if (!this.verifyCommandNames && this.testClosureEnd()) return true;
    if (this.verifyCommandNames && !this.flags[ParserFlag.STRICT_ESCAPING] && this.testCommandEnd()) {
      throw new ScriptParserError(
        `Unexpected end of quoted value at position ${this.index}`,
        this.text,
        this.index,
      );
    }
    return this.testSymbol('"') || (!this.flags[ParserFlag.STRICT_ESCAPING] && this.testCommandEnd());
  }
  parseQuotedValue() {
    this.take(); // "
    let value = '';
    while (!this.testQuotedValueEnd()) value += this.take();
    this.take(); // "
    return value;
  }

  testListValue() {
    return this.testSymbol('[');
  }
  testListValueEnd() {
    if (this.endOfText)
      throw new ScriptParserError(
        `Unexpected end of list value at position ${this.index}`,
        this.text,
        this.index,
      );
    return this.testSymbol(']');
  }
  parseListValue() {
    let value = this.take();
    while (!this.testListValueEnd()) value += this.take();
    value += this.take();
    return value;
  }

  testValue() {
    return !this.testSymbol(/\s/);
  }
  testValueEnd() {
    if (this.testSymbol(/\s/)) return true;
    return this.testCommandEnd();
  }
  parseValue() {
    let value = this.jumpedEscapeSequence ? this.take() : '';
    while (!this.testValueEnd()) value += this.take();
    return value;
  }
}
