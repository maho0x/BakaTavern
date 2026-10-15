import type { MacroEnv } from './env.ts';

export interface MacroFlags {
  /** `#`: keep whitespace of scoped content. */
  preserveWhitespace: boolean;
}

export interface MacroCall {
  name: string;
  /** Arguments with nested macros resolved (raw text when `delayArgResolution` is set). */
  args: string[];
  rawArgs: string[];
  isScoped: boolean;
  flags: MacroFlags;
  env: MacroEnv;
  /** Position of the macro in the top-level text, used to seed deterministic randomness. */
  offset: number;
  /** Evaluates macros in `text` with the same environment. */
  resolve: (text: string) => string;
  trimContent: (text: string) => string;
}

export type MacroResult = string | number | boolean | null | undefined | object;

export interface MacroDefinition {
  handler: (call: MacroCall) => MacroResult;
  /** Pass arguments unresolved (the handler resolves what it needs, e.g. `if`). */
  delayArgResolution?: boolean;
  minArgs?: number;
  /** Maximum number of arguments; a scoped block counts as one more argument. */
  maxArgs?: number;
  description?: string;
  category?: string;
  aliases?: string[];
}

/** Case-insensitive macro registry. */
export class MacroRegistry {
  #defs = new Map<string, MacroDefinition>();

  register(name: string, def: MacroDefinition): this {
    this.#defs.set(name.toLowerCase(), def);
    for (const alias of def.aliases ?? []) this.#defs.set(alias.toLowerCase(), def);
    return this;
  }

  unregister(name: string): void {
    this.#defs.delete(name.toLowerCase());
  }

  get(name: string): MacroDefinition | undefined {
    return this.#defs.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.#defs.has(name.toLowerCase());
  }

  names(): string[] {
    return [...this.#defs.keys()];
  }

  /** Can this macro take a scoped block given how many arguments were written inline? */
  acceptsScope(name: string, inlineArgs: number): boolean {
    const def = this.get(name);
    if (!def) return false;
    return inlineArgs < (def.maxArgs ?? Number.POSITIVE_INFINITY);
  }
}
