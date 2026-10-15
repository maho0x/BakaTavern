import { PostProcessing } from './preset.ts';
import type { ChatMessage } from './types.ts';

export const PROMPT_PLACEHOLDER = "Let's get started.";

export interface PromptNames {
  charName: string;
  userName: string;
  groupNames: readonly string[];
}

const startsWithGroupName = (names: PromptNames, text: string) =>
  names.groupNames.some((n) => text.startsWith(`${n}: `));

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n');
}

interface MergeOptions {
  strict?: boolean;
  placeholders?: boolean;
  single?: boolean;
  tools?: boolean;
}

/**
 * SillyTavern `mergeMessages`: inlines names, squashes consecutive same-role messages and, in
 * strict mode, keeps a single leading system message followed by a user turn.
 */
export function mergeMessages(
  input: readonly ChatMessage[],
  names: PromptNames,
  options: MergeOptions = {},
): ChatMessage[] {
  const { strict = false, placeholders = false, single = false, tools = false } = options;
  const messages = input.map((m) => {
    const message: ChatMessage = { ...m };
    let content =
      Array.isArray(m.content) && m.content.some((p) => p.type !== 'text') ? m.content : textOf(m);
    if (typeof content === 'string') {
      if (message.role === 'system' && message.name === 'example_assistant') {
        if (
          names.charName &&
          !content.startsWith(`${names.charName}: `) &&
          !startsWithGroupName(names, content)
        ) {
          content = `${names.charName}: ${content}`;
        }
      }
      if (message.role === 'system' && message.name === 'example_user') {
        if (names.userName && !content.startsWith(`${names.userName}: `))
          content = `${names.userName}: ${content}`;
      }
      if (message.name && message.role !== 'system' && !content.startsWith(`${message.name}: `)) {
        content = `${message.name}: ${content}`;
      }
      if (single) {
        if (
          message.role === 'assistant' &&
          names.charName &&
          !content.startsWith(`${names.charName}: `) &&
          !startsWithGroupName(names, content)
        ) {
          content = `${names.charName}: ${content}`;
        }
        if (message.role === 'user' && names.userName && !content.startsWith(`${names.userName}: `)) {
          content = `${names.userName}: ${content}`;
        }
      }
    }
    message.content = content;
    if (message.role === 'tool' && !tools) message.role = 'user';
    if (single) message.role = 'user';
    delete message.name;
    if (!tools) {
      delete message.tool_calls;
      delete message.tool_call_id;
    }
    return message;
  });

  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.role === message.role &&
      message.content &&
      message.role !== 'tool' &&
      typeof last.content === 'string' &&
      typeof message.content === 'string'
    ) {
      last.content += '\n\n' + message.content;
    } else {
      merged.push(message);
    }
  }
  if (merged.length === 0) merged.push({ role: 'user', content: PROMPT_PLACEHOLDER });

  if (strict) {
    for (let i = 1; i < merged.length; i++) if (merged[i]!.role === 'system') merged[i]!.role = 'user';
    if (merged.length && placeholders) {
      if (merged[0]!.role === 'system' && (merged.length === 1 || merged[1]!.role !== 'user')) {
        merged.splice(1, 0, { role: 'user', content: PROMPT_PLACEHOLDER });
      } else if (merged[0]!.role !== 'system' && merged[0]!.role !== 'user') {
        merged.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
      }
    }
    return mergeMessages(merged, names, { strict: false, placeholders, single: false, tools });
  }
  return merged;
}

/** Applies the preset's "prompt post-processing" mode (SillyTavern `postProcessPrompt`). */
export function postProcessPrompt(
  messages: readonly ChatMessage[],
  type: string,
  names: PromptNames,
): ChatMessage[] {
  switch (type) {
    case PostProcessing.MERGE:
    case PostProcessing.CLAUDE:
      return mergeMessages(messages, names);
    case PostProcessing.MERGE_TOOLS:
      return mergeMessages(messages, names, { tools: true });
    case PostProcessing.SEMI:
      return mergeMessages(messages, names, { strict: true });
    case PostProcessing.SEMI_TOOLS:
      return mergeMessages(messages, names, { strict: true, tools: true });
    case PostProcessing.STRICT:
      return mergeMessages(messages, names, { strict: true, placeholders: true });
    case PostProcessing.STRICT_TOOLS:
      return mergeMessages(messages, names, { strict: true, placeholders: true, tools: true });
    case PostProcessing.SINGLE:
      return mergeMessages(messages, names, { strict: true, single: true });
    default:
      return [...messages];
  }
}
