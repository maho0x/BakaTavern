/**
 * BakaTavern plugin API, version 1.
 *
 * A plugin is an ES module whose default export is `definePlugin({...})`. The app loads it into
 * the page, asks the user to grant the permissions it lists, and calls `activate` with a context
 * that holds only the parts of the app those permissions open. Everything a plugin registers is
 * removed again when it is turned off.
 *
 * ```js
 * import { definePlugin } from '@bakatavern/plugin-api'; // types only; or write the object as is
 * export default definePlugin({
 *   id: 'dice',
 *   name: 'Dice',
 *   version: '1.0.0',
 *   permissions: ['commands'],
 *   activate(ctx) {
 *     ctx.commands.register({ name: 'd20', callback: () => String(1 + Math.floor(Math.random() * 20)) });
 *   },
 * });
 * ```
 */

export const PLUGIN_API_VERSION = 1;

/** What a plugin may reach. */
export type Permission =
  /** Read the open chat and add messages to it. */
  | 'chat'
  /** Ask the model (background generations). */
  | 'generate'
  /** Change what is sent to the model: injections and prompt hooks. */
  | 'prompt'
  /** Register STscript commands and macros. */
  | 'commands'
  /** Register function tools the model may call. */
  | 'tools'
  /** Fetch from the network through the server (it attaches no keys). */
  | 'network'
  /** Add buttons and a settings section. */
  | 'ui';

export interface PluginManifest {
  /** Lowercase letters, digits and dashes; unique among plugins. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** The plugin API version it was written for. */
  apiVersion?: number;
  permissions: Permission[];
}

export interface Plugin extends PluginManifest {
  /** Called when the plugin is turned on (also when the app starts). May return a clean-up. */
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

/** Marks a plugin definition (types only; returns it unchanged). */
export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin;
}

/** Stops what a registration started. */
export type Dispose = () => void;

export interface ChatMessage {
  index: number;
  name: string;
  role: 'user' | 'assistant' | 'system';
  hidden: boolean;
  text: string;
  /** SillyTavern's `message.extra`. */
  extra: Record<string, unknown>;
}

export interface Injection {
  content: string;
  /** `in_chat` places it among the messages at `depth`. */
  position: 'in_prompt' | 'in_chat' | 'before_prompt' | 'none';
  depth?: number;
  role?: 'system' | 'user' | 'assistant';
  /** Let World Info see it. */
  scan?: boolean;
}

export interface PromptHooks {
  /**
   * Before the prompt is built: the messages it is built from (a copy the hook may change, e.g.
   * drop or add messages), as SillyTavern's generate interceptors do.
   */
  beforeBuild?(context: { type: string; messages: ChatMessage[] }): void | Promise<void>;
  /** After a reply arrived, before it is stored: return the text to store instead. */
  afterResponse?(text: string, context: { type: string }): string | void | Promise<string | void>;
}

export interface Tool {
  name: string;
  displayName?: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
  action(parameters: Record<string, unknown>): unknown;
  formatMessage?(parameters: Record<string, unknown>): string | Promise<string>;
  shouldRegister?(): boolean | Promise<boolean>;
  stealth?: boolean;
}

export interface Command {
  name: string;
  aliases?: string[];
  helpString?: string;
  /** Named arguments arrive as text, the rest as `value`; return the result for the pipe. */
  callback(args: Record<string, unknown>, value: unknown): unknown;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  /** The app's events (SillyTavern's names: `message_received`, `chat_id_changed`, ...). */
  readonly events: {
    on(event: string, listener: (...args: unknown[]) => unknown): Dispose;
    once(event: string, listener: (...args: unknown[]) => unknown): Dispose;
    emit(event: string, ...args: unknown[]): Promise<void>;
    readonly types: Readonly<Record<string, string>>;
  };
  /** The plugin's own settings, kept on the server. */
  readonly storage: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
  readonly chat: {
    /** Needs `chat`. */
    messages(): ChatMessage[];
    current(): { id: string; title: string; characterName: string | null } | null;
    /** Data the plugin keeps in the open chat (saved with it). Needs `chat`. */
    getData<T = unknown>(key: string): T | undefined;
    setData(key: string, value: unknown): Promise<void>;
    /** Adds a message without asking for a reply. Needs `chat`. */
    addMessage(message: {
      role: 'user' | 'assistant' | 'system';
      name?: string;
      text: string;
    }): Promise<void>;
  };
  /** Needs `generate`. */
  readonly llm: {
    /** A background reply to an instruction, with the chat as context. */
    generate(prompt: string, options?: { responseLength?: number }): Promise<string>;
    /** A reply to these messages only. */
    generateRaw(
      messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
      options?: { responseLength?: number; systemPrompt?: string },
    ): Promise<string>;
  };
  /** Needs `prompt`. */
  readonly prompt: {
    inject(id: string, injection: Injection): void;
    uninject(id: string): void;
    hooks(hooks: PromptHooks): Dispose;
  };
  /** Needs `commands`. */
  readonly commands: {
    register(command: Command): Dispose;
    /** Runs an STscript; resolves to its result. */
    run(script: string): Promise<string>;
  };
  /** Needs `commands`. */
  readonly macros: {
    /** `{{name::arg1::arg2}}` → what the handler returns. */
    register(name: string, handler: (args: string[]) => unknown, description?: string): Dispose;
  };
  /** Needs `tools`. */
  readonly tools: {
    register(tool: Tool): Dispose;
  };
  /** Needs `network`. Requests go through the server, which refuses private addresses. */
  readonly net: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<FetchResult>;
  };
  readonly ui: {
    toast(message: string, kind?: 'info' | 'success' | 'warning' | 'error'): void;
    /** Needs `ui`. A section in the Plugins panel; `mount` may return a clean-up. */
    settings(mount: (element: HTMLElement) => void | Dispose): Dispose;
    /** Needs `ui`. An entry in each message's options menu. */
    messageAction(action: { label: string; onClick(index: number): unknown }): Dispose;
    /** Needs `ui`. An entry in the message box's actions menu. */
    composerAction(action: { label: string; onClick(): unknown }): Dispose;
  };
}
