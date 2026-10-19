/**
 * The STscript runtime: the command registry, parsing and running scripts with the app's macros
 * (SillyTavern `executeSlashCommandsWithOptions`).
 */

import type { MacroEngine } from '../macros/engine.ts';
import type { MacroEnv } from '../macros/env.ts';
import type { Closure } from './closure.ts';
import {
  ClosureResult,
  ScriptAbortController,
  ScriptExecutionError,
  ScriptParserError,
  type ClosureHost,
  type Scope,
} from './closure.ts';
import { Parser, RESERVED_COMMAND_STARTS, type ParserFlags } from './parser.ts';
import type { CommandDefinition } from './types.ts';
import type { VariableStores } from './variables.ts';

/** Case-sensitive command names and aliases, like SillyTavern's. */
export class CommandRegistry {
  #commands = new Map<string, CommandDefinition>();

  /** Adds a command; `unsafe` skips the check for reserved names (the parser's own). */
  add(command: CommandDefinition, unsafe = false): this {
    const names = [command.name, ...(command.aliases ?? [])];
    if (!unsafe) {
      for (const start of RESERVED_COMMAND_STARTS) {
        if (names.some((n) => n.toLowerCase().startsWith(start))) {
          throw new Error(`Illegal Name. Slash command name cannot begin with "${start}".`);
        }
      }
    }
    for (const name of names) this.#commands.set(name, command);
    return this;
  }

  remove(name: string) {
    const command = this.#commands.get(name);
    if (!command) return;
    for (const n of [command.name, ...(command.aliases ?? [])]) {
      if (this.#commands.get(n) === command) this.#commands.delete(n);
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.#commands.get(name);
  }

  /** Every command once (not per alias), by name. */
  list(): CommandDefinition[] {
    return [...new Set(this.#commands.values())].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** How a script shows things (SillyTavern's toasts and popups). */
export interface ScriptUi {
  toast(
    text: string,
    kind: 'info' | 'warning' | 'error' | 'success',
    options?: { html?: boolean; title?: string },
  ): void;
  /** A popup with text or sanitized HTML; resolves when closed. */
  popup(content: string, options?: { html?: boolean }): Promise<void>;
  /** A system message in the chat. */
  systemMessage(text: string, options?: { html?: boolean }): Promise<void>;
}

export interface StscriptOptions {
  macros: MacroEngine;
  /** The macro environment of the current chat (names, card fields, variables, ...). */
  env: () => MacroEnv;
  /** The chat's and the global variables. */
  variables: () => VariableStores;
  ui?: ScriptUi;
  /** Runs a Quick Reply by name for `/run` and `/:` (args become `{{arg::name}}`). */
  runQuickReply?: (name: string, args: Record<string, unknown>, options: ExecuteOptions) => Promise<unknown>;
  /** The open chat's name (SillyTavern's chat file name). */
  chatName?: () => string;
  /** Default parser flags (the user's STscript settings). */
  parserFlags?: () => ParserFlags;
}

export interface ExecuteOptions {
  /** Parent scope: the script sees its variables. */
  scope?: Scope | null;
  parserFlags?: ParserFlags | null;
  abortController?: ScriptAbortController | null;
  /** Report parser errors (through the UI) instead of throwing them. */
  handleParserErrors?: boolean;
  handleExecutionErrors?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export class Stscript {
  readonly commands = new CommandRegistry();
  readonly host: ClosureHost;
  readonly options: StscriptOptions;

  constructor(options: StscriptOptions) {
    this.options = options;
    this.host = {
      substitute: (text, dynamic) => {
        const env = options.env();
        return options.macros.evaluate(text, { ...env, dynamic: { ...env.dynamic, ...dynamic } });
      },
    };
  }

  get ui(): ScriptUi | undefined {
    return this.options.ui;
  }

  get variables(): VariableStores {
    return this.options.variables();
  }

  parser() {
    return new Parser((name) => this.commands.get(name), this.host);
  }

  /** Parses a script into its root closure (throws `ScriptParserError`). */
  parse(text: string, options: Pick<ExecuteOptions, 'parserFlags' | 'abortController'> = {}): Closure {
    return this.parser().parse(
      text,
      true,
      options.parserFlags ?? this.options.parserFlags?.() ?? null,
      options.abortController ?? new ScriptAbortController(),
    );
  }

  /** Runs a script; `null` for empty text. */
  async execute(text: string, options: ExecuteOptions = {}): Promise<ClosureResult | null> {
    if (!text) return null;
    const handleParserErrors = options.handleParserErrors ?? true;
    let closure: Closure;
    try {
      closure = this.parse(text, options);
      closure.scope.parent = options.scope ?? null;
      closure.onProgress = options.onProgress ?? null;
    } catch (error) {
      if (handleParserErrors && error instanceof ScriptParserError) {
        this.ui?.toast(`${error.message} (line ${error.line + 1}, column ${error.column + 1})`, 'error', {
          title: 'STscript',
        });
        const result = new ClosureResult();
        result.isError = true;
        result.errorMessage = error.message;
        return result;
      }
      throw error;
    }
    try {
      const result = await closure.execute();
      if (result.isAborted && !result.isQuietlyAborted) {
        this.ui?.toast(result.abortReason, 'warning', { title: 'Command execution aborted' });
        if (closure.abortController) closure.abortController.signal.isQuiet = true;
      }
      return result;
    } catch (error) {
      if (options.handleExecutionErrors) {
        const message = (error as Error)?.message ?? String(error);
        this.ui?.toast(
          error instanceof ScriptExecutionError
            ? `${message} (/${error.commandName}, line ${error.line + 1})`
            : message,
          'error',
        );
        const result = new ClosureResult();
        result.isError = true;
        result.errorMessage = message;
        return result;
      }
      throw error;
    }
  }

  /** A command given as text inside another (`/if ... "/echo hi"`), run in the caller's scope. */
  async executeSubCommands(
    command: string,
    scope: Scope | null,
    parserFlags: ParserFlags | null,
    abortController: ScriptAbortController | null,
  ): Promise<ClosureResult> {
    if (command.startsWith('"') && command.endsWith('"')) command = command.slice(1, -1);
    const result = await this.execute(command, {
      handleExecutionErrors: false,
      handleParserErrors: false,
      parserFlags,
      scope,
      abortController: abortController ?? new ScriptAbortController(),
    });
    return result ?? new ClosureResult();
  }

  /**
   * Gives a value back the way a command's `return=` asks (SillyTavern `slashCommandReturnHelper`):
   * into the pipe, as JSON, or shown in a popup, the chat or a toast.
   */
  async doReturn(
    type: string,
    value: unknown,
    options: { toText?: (value: unknown) => string; toHtml?: (value: unknown) => string } = {},
  ): Promise<string> {
    const html = type.endsWith('html');
    const convert = (html && options.toHtml) || options.toText || ((v: unknown) => String(v));
    const text = typeof value === 'string' ? value : convert(value);
    switch (type) {
      case 'popup-html':
      case 'popup-text':
        await this.ui?.popup(text, { html });
        return '';
      case 'chat-html':
      case 'chat-text':
        await this.ui?.systemMessage(text, { html });
        return '';
      case 'toast-html':
      case 'toast-text':
        this.ui?.toast(text, 'info', { html });
        return '';
      case 'pipe':
        return text ?? '';
      case 'object':
        return JSON.stringify(value);
      case 'console':
        console.info(value);
        return '';
      case 'none':
        return '';
      default:
        throw new Error(`Unknown return type: ${type}`);
    }
  }
}
