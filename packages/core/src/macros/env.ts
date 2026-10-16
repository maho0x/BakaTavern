/** A variable store (chat-local or global). Values are strings, numbers or JSON-compatible data. */
export interface VariableScope {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  has(name: string): boolean;
  delete(name: string): void;
}

/** Variable store over a plain object (e.g. `chat_metadata.variables`). Mutates `target`. */
export function objectVariables(target: Record<string, unknown>): VariableScope {
  return {
    get: (name) => target[name],
    set: (name, value) => {
      target[name] = value;
    },
    has: (name) => Object.hasOwn(target, name),
    delete: (name) => {
      delete target[name];
    },
  };
}

export interface MacroChatMessage {
  name: string;
  role: 'user' | 'assistant' | 'system';
  hidden: boolean;
  text: string;
  swipeId: number;
  swipeCount: number;
}

/** Everything macros can read. Fields are optional; missing values expand to an empty string. */
export interface MacroEnv {
  user: string;
  char: string;
  /** Group member names, comma separated (falls back to `char`). */
  group?: string;
  groupNotMuted?: string;
  /** Everyone in the chat except `char`. */
  notChar?: string;
  isGroup?: boolean;

  description?: string;
  personality?: string;
  scenario?: string;
  persona?: string;
  mesExamples?: string;
  mesExamplesRaw?: string;
  charPrompt?: string;
  charInstruction?: string;
  charDepthPrompt?: string;
  creatorNotes?: string;
  charVersion?: string;
  firstMessage?: string;
  alternateGreetings?: readonly string[];
  /** Instruct template in effect, only when instruct mode is on (SillyTavern keys). */
  instruct?: Readonly<Record<string, unknown>>;
  /** System prompt, only when enabled (SillyTavern `power_user.sysprompt`). */
  sysprompt?: { content: string };
  /** `{{systemPrompt}}` gives the card's system prompt when it has one. */
  preferCharacterPrompt?: boolean;
  /** Context template separators. */
  chatStart?: string;
  exampleSeparator?: string;

  model?: string;
  /** Original text a macro-bearing override replaces (`{{original}}`). */
  original?: string;
  /** Current user input box contents. */
  input?: string;
  lastGenerationType?: string;
  maxPromptTokens?: number;
  maxContextTokens?: number;
  maxResponseTokens?: number;

  messages?: readonly MacroChatMessage[];
  /** Index of the first message that fits into the prompt. */
  firstIncludedMessageId?: number;
  firstDisplayedMessageId?: number;

  localVariables?: VariableScope;
  globalVariables?: VariableScope;

  /** Seed for deterministic picks (usually the chat id). */
  chatId?: string;
  now?: () => Date;
  random?: () => number;
  /** Ids of enabled extensions/plugins. */
  extensions?: readonly string[];
  /** World Info outlets by name. */
  outlets?: Readonly<Record<string, string>>;
  /** Collects words from `{{banned "..."}}` (text completion token bans). */
  bannedWords?: string[];
  /** Time since the last user message, humanized ("5 minutes"). */
  idleDuration?: string;
  isMobile?: boolean;
  /** Extra simple macros (plugins, overrides) resolved by name, before the registered ones. */
  dynamic?: Readonly<Record<string, string | (() => string)>>;
  /** Applied to the output of every macro call (e.g. escaping for a regex). */
  postProcess?: (value: string) => string;
}
