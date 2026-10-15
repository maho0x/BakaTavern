/** Shared prompt types (OpenAI-style messages are the internal lingua franca). */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'video_url'; video_url: { url: string; detail?: string } }
  | { type: 'audio_url'; audio_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  signature?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Provider reasoning signature to send back (Claude/Gemini thinking). */
  signature?: string;
  reasoning?: string;
}

export type GenerationType = 'normal' | 'swipe' | 'regenerate' | 'continue' | 'impersonate' | 'quiet';

/** SillyTavern `extension_prompt_types`. */
export const ExtensionPromptPosition = {
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2,
} as const;

/** SillyTavern `extension_prompt_roles`. */
export const ExtensionPromptRole = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
} as const;

/** A prompt injection registered under a key (`2_floating_prompt`, `DEPTH_PROMPT`, ...). */
export interface ExtensionPrompt {
  value: string;
  position: number;
  depth: number;
  role: number;
  /** Include in the World Info scan. */
  scan: boolean;
}

/** Well-known injection keys (match SillyTavern so lexical ordering is identical). */
export const InjectKeys = {
  MEMORY: '1_memory',
  AUTHORS_NOTE: '2_floating_prompt',
  VECTORS: '3_vectors',
  VECTORS_DATA_BANK: '4_vectors_data_bank',
  SMART_CONTEXT: 'chromadb',
  PERSONA_DESCRIPTION: 'PERSONA_DESCRIPTION',
  QUIET_PROMPT: 'QUIET_PROMPT',
  DEPTH_PROMPT: 'DEPTH_PROMPT',
  STORY_STRING: '__STORY_STRING__',
  depthPromptIndex: (i: number) => `DEPTH_PROMPT_${i}`,
  worldInfoDepth: (depth: number, role: number) => `customDepthWI_${depth}_${role}`,
  worldInfoOutlet: (name: string) => `customWIOutlet_${name}`,
} as const;

export const MAX_INJECTION_DEPTH = 10000;

/** Joins the injections at one position (and optionally depth/role), like ST's `getExtensionPrompt`. */
export function joinExtensionPrompts(
  prompts: Readonly<Record<string, ExtensionPrompt>>,
  position: number,
  options: { depth?: number; role?: number; separator?: string; wrap?: boolean } = {},
): string {
  const { depth, role, separator = '\n', wrap = true } = options;
  let value = Object.keys(prompts)
    .sort()
    .map((k) => prompts[k]!)
    .filter((p) => p.position === position && p.value)
    .filter((p) => depth === undefined || p.depth === undefined || p.depth === depth)
    .filter((p) => role === undefined || p.role === undefined || p.role === role)
    .map((p) => p.value.trim())
    .join(separator);
  if (wrap && value.length && !value.startsWith(separator)) value = separator + value;
  if (wrap && value.length && !value.endsWith(separator)) value = value + separator;
  return value;
}
