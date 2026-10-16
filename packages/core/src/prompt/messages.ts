import { parseExampleIntoIndividual } from './instruct.ts';
import type { ToolInvocation } from '../tools.ts';
import type { MessageAttachments } from './media.ts';
import { NamesBehavior } from './preset.ts';
import type { ChatMessage } from './types.ts';

/** A chat message reduced to what prompt building needs. */
export interface HistoryMessage {
  name: string;
  /** `system` marks a narrator message. */
  role: 'user' | 'assistant' | 'system';
  /** Active swipe text, after regex and reasoning handling. */
  content: string;
  /** The message was sent as another character (`/sendas`, SillyTavern `force_avatar`). */
  forceAvatar?: boolean;
  signature?: string;
  reasoning?: string;
  /** Attachments that can be inlined (Chat Completion). */
  media?: MessageAttachments;
  /** Tool calls the message records (`extra.tool_invocations`). */
  invocations?: ToolInvocation[];
}

/** A history message for Chat Completion, with what is added to it in the prompt. */
export type HistoryPrompt = ChatMessage & { media?: MessageAttachments; invocations?: ToolInvocation[] };

export interface HistoryOptions {
  namesBehavior: number;
  userName: string;
  isGroup: boolean;
}

/** Chat history → Chat Completion messages (SillyTavern `setOpenAIMessages`), chronological. */
export function toPromptMessages(
  history: readonly HistoryMessage[],
  options: HistoryOptions,
): HistoryPrompt[] {
  return history.map((m) => {
    const narrator = m.role === 'system';
    const role = m.role === 'user' ? 'user' : narrator ? 'system' : 'assistant';
    let content = m.content;
    switch (options.namesBehavior) {
      case NamesBehavior.DEFAULT:
        if (
          (options.isGroup && m.name !== options.userName) ||
          (m.forceAvatar && m.name !== options.userName && !narrator)
        ) {
          content = `${m.name}: ${content}`;
        }
        break;
      case NamesBehavior.CONTENT:
        if (!narrator) content = `${m.name}: ${content}`;
        break;
    }
    return {
      role,
      content: content.replace(/\r/gm, ''),
      name: m.name,
      ...(m.signature ? { signature: m.signature } : {}),
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.media?.media.length ? { media: m.media } : {}),
      ...(m.invocations ? { invocations: m.invocations } : {}),
    };
  });
}

/**
 * Splits example dialogue text into blocks (SillyTavern `parseMesExamples`). For Chat Completion
 * and instruct mode every block starts with `<START>\n`; otherwise with `separator`.
 */
export function parseMesExamples(examples: string, blockHeading = '<START>\n'): string[] {
  if (!examples || examples === '<START>') return [];
  const text = examples.startsWith('<START>') ? examples : `<START>\n${examples.trim()}`;
  return text
    .split(/<START>/gi)
    .slice(1)
    .map((block) => `${blockHeading}${block.trim()}\n`);
}

export interface ExampleOptions {
  userName: string;
  charName: string;
  groupNames: readonly string[];
  isGroup: boolean;
}

/** Example blocks → messages named `example_user` / `example_assistant` (`parseExampleIntoIndividual`). */
export function examplesToMessages(blocks: readonly string[], options: ExampleOptions): ChatMessage[][] {
  return blocks.map((block) =>
    parseExampleIntoIndividual(block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, ''), {
      userName: options.userName,
      charName: options.charName,
      groupNames: options.groupNames,
      appendNames: options.isGroup,
    }).map((m) => ({ role: 'system', content: m.content, name: m.name })),
  );
}
