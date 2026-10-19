/**
 * What a front-end frame (a message's HTML or a TavernHelper script) and the page that shows it
 * tell each other. In safe mode the frame is sandboxed without the page's origin, so everything
 * crosses through `postMessage`: the frame keeps a copy of the chat state (to answer TavernHelper's
 * synchronous functions) and asks the page to do the rest.
 */

import type { RegexScript } from '@bakatavern/core/regex/engine';

/** Marks bridge messages among others a page may receive. */
export const BRIDGE_TAG = 'bt-th';

export type FrameKind = 'message' | 'script';

/** A chat message as TavernHelper sees it (SillyTavern's message, every swipe). */
export interface MessageState {
  name: string;
  role: 'user' | 'assistant' | 'system';
  is_hidden: boolean;
  swipe_id: number;
  swipes: string[];
  /** Message variables per swipe (SillyTavern `message.variables`). */
  swipes_data: Record<string, unknown>[];
  /** SillyTavern `swipe_info`. */
  swipes_info: Record<string, unknown>[];
  extra: Record<string, unknown>;
  send_date: string;
}

export interface CharacterState {
  name: string;
  /** SillyTavern's file name for it (`Name.png`). */
  avatar: string;
  /** Its picture, as a URL the frame can load. */
  avatarUrl: string;
  /** The card (V2/V3 JSON). */
  card: Record<string, unknown>;
}

/** The regex scripts SillyTavern would run, with where each comes from. */
export interface RegexState {
  global: RegexScript[];
  character: RegexScript[];
  preset: RegexScript[];
  characterEnabled: boolean;
  presetEnabled: boolean;
}

/** Everything a frame may read without waiting. */
export interface BridgeState {
  chatId: string | null;
  messages: MessageState[];
  variables: {
    global: Record<string, unknown>;
    chat: Record<string, unknown>;
    character: Record<string, unknown> | null;
    preset: Record<string, unknown>;
  };
  user: { name: string; avatarUrl: string; persona: string };
  character: CharacterState | null;
  group: { name: string; members: string[] } | null;
  /** Every character, with the lorebooks bound to it. */
  characters: { name: string; avatar: string; lorebooks: { primary: string | null; additional: string[] } }[];
  personas: string[];
  lorebooks: {
    names: string[];
    global: string[];
    chat: string | null;
    character: { primary: string | null; additional: string[] };
  };
  regex: RegexState;
  /** Data of the scripts that run (TavernHelper script variables), by script id. */
  scripts: Record<
    string,
    { name: string; data: Record<string, unknown>; buttons: ScriptButton[]; info: string }
  >;
  /** The reply being written, if any. */
  generating: boolean;
}

export interface ScriptButton {
  name: string;
  visible: boolean;
}

/** What a frame starts with (written into its document). */
export interface FrameConfig {
  /** Iframe name as TavernHelper gives it: `TH-message--<floor>--<n>` or `TH-script--<name>--<id>`. */
  name: string;
  kind: FrameKind;
  /** Identifies the frame's messages to the page. */
  token: string;
  messageId?: number;
  scriptId?: string;
  state: BridgeState;
  viewportHeight: number;
  /** Globals other frames shared so far (`initializeGlobal`). */
  globals: Record<string, GlobalShape>;
}

/** A shared global: data copied by value, functions called in the frame that owns it. */
export interface GlobalShape {
  data: unknown;
  functions: string[];
}

/** Frame → page. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'call'; id: number; method: string; args: unknown[] }
  | { type: 'notify'; method: string; args: unknown[] }
  | { type: 'height'; height: number }
  | { type: 'subscribe'; event: string }
  | { type: 'unsubscribe'; event: string }
  | { type: 'emit'; id: number; event: string; args: unknown[] }
  | { type: 'event-done'; id: number }
  | { type: 'global'; name: string; shape: GlobalShape }
  | { type: 'global-call'; id: number; name: string; fn: string; args: unknown[] }
  | { type: 'global-result'; id: number; value?: unknown; error?: string };

/** Page → frame. */
export type HostMessage =
  | { type: 'state'; state: BridgeState }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'event'; id: number; event: string; args: unknown[] }
  | { type: 'viewport'; height: number }
  | { type: 'global'; name: string; shape: GlobalShape }
  | { type: 'global-call'; id: number; name: string; fn: string; args: unknown[] }
  | { type: 'global-result'; id: number; value?: unknown; error?: string };

export type Envelope<T> = T & { [BRIDGE_TAG]: true; token: string };

/** TavernHelper's own events (`iframe_events`). */
export const iframeEvents = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_REQUESTED: 'js_generation_requested',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
} as const;

/** Frame names TavernHelper uses; scripts read their message id or script id back from them. */
export function messageFrameName(messageId: number, index: number): string {
  return `TH-message--${messageId}--${index}`;
}

export function scriptFrameName(scriptName: string, scriptId: string): string {
  return `TH-script--${scriptName}--${scriptId}`;
}
