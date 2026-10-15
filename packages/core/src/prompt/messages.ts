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
}

export interface HistoryOptions {
  namesBehavior: number;
  userName: string;
  isGroup: boolean;
}

/** Chat history → Chat Completion messages (SillyTavern `setOpenAIMessages`), chronological. */
export function toPromptMessages(history: readonly HistoryMessage[], options: HistoryOptions): ChatMessage[] {
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
  return blocks.map((block) => {
    const text = block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
    const groupBotNames = options.groupNames.map((n) => `${n}:`);
    const result: ChatMessage[] = [];
    const lines = text.split('\n');
    let current: string[] = [];
    let inUser = false;
    let inBot = false;
    let botName = options.charName;
    const add = (name: string, systemName: 'example_user' | 'example_assistant') => {
      let parsed = current.join('\n').replace(`${name}:`, '').trim();
      if (options.isGroup) parsed = `${name}: ${parsed}`;
      result.push({ role: 'system', content: parsed, name: systemName });
      current = [];
    };
    // The first line is always the "{Example Dialogue:}" heading.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith(`${options.userName}:`)) {
        inUser = true;
        if (inBot) add(botName, 'example_assistant');
        inBot = false;
      } else if (line.startsWith(`${options.charName}:`) || groupBotNames.some((n) => line.startsWith(n))) {
        if (!line.startsWith(`${options.charName}:`) && groupBotNames.length) botName = line.split(':')[0]!;
        inBot = true;
        if (inUser) add(options.userName, 'example_user');
        inUser = false;
      }
      current.push(line);
    }
    if (inUser) add(options.userName, 'example_user');
    else if (inBot) add(botName, 'example_assistant');
    return result;
  });
}
