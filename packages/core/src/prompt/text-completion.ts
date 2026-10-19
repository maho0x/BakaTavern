/**
 * Text Completion prompt building: the Text Completion branch of SillyTavern's `Generate()`
 * (story string, in-chat injections, post-history instructions, chat history in plain or instruct
 * format, the context budget, examples, the last prompt line and "Start reply with").
 */

import {
  ForceSequence,
  formatInstructChat,
  formatInstructExamples,
  formatInstructPrompt,
  formatInstructStoryString,
  renderStoryString,
  type ContextTemplate,
  type InstructContext,
  type InstructTemplate,
} from './instruct.ts';
import {
  ExtensionPromptPosition,
  ExtensionPromptRole,
  InjectKeys,
  joinExtensionPrompts,
  type ExtensionPrompt,
  type GenerationType,
} from './types.ts';

/** SillyTavern's `MAX_INJECTION_DEPTH`. */
const MAX_INJECTION_DEPTH = 10000;

/** A chat message on its way into a Text Completion prompt. */
export interface TextCompletionMessage {
  /** Missing for the post-history instructions. */
  name?: string;
  mes: string;
  isUser: boolean;
  /** A narrator (system) message: no name, system sequences. */
  isNarrator: boolean;
  forceAvatar?: boolean;
}

export interface TextCompletionInput {
  type: GenerationType;
  userName: string;
  charName: string;
  instructEnabled: boolean;
  instruct: InstructTemplate;
  context: ContextTemplate;
  /** Story string fields. `system` is the system prompt in effect; `persona` only when in the prompt. */
  story: {
    description: string;
    personality: string;
    persona: string;
    scenario: string;
    system: string;
    wiBefore: string;
    wiAfter: string;
  };
  /** Post-history instructions in effect ('' for none). */
  postHistory: string;
  /** Prompt injections (Author's Note, depth prompts, World Info at depth ...). Mutated. */
  extensionPrompts: Record<string, ExtensionPrompt>;
  /** Messages that enter the prompt, oldest first, after regex scripts and reasoning. */
  messages: TextCompletionMessage[];
  /** Example dialogue blocks (`parseMesExamples` for this mode, World Info examples included). */
  examples: string[];
  /** "Start reply with" in effect ('' for none). */
  promptBias: string;
  /** Put the character's name before the reply (non-instruct). */
  forceName2: boolean;
  quietPrompt?: string;
  quietToLoud?: boolean;
  quietName?: string;
  /** Messages in the chat, hidden ones included, and whether the last one is the user's. */
  chatLength: number;
  lastIsUser: boolean;
  pinExamples: boolean;
  stripExamples: boolean;
  collapseNewlines: boolean;
  /** Tokens added to every whole-prompt count (SillyTavern `token_padding`). */
  tokenPadding: number;
  /** Context size minus response length. */
  maxPromptTokens: number;
  countTokens: (text: string) => number | Promise<number>;
  substitute: (text: string, names?: { user: string; char: string }) => string;
  isGroup?: boolean;
  groupNames?: readonly string[];
}

export interface TextCompletionResult {
  prompt: string;
  /** The rendered story string (empty when injected into the chat). */
  storyString: string;
  examples: string;
  /** The chat history part, including the chat start separator and the last prompt line. */
  messages: string;
  /** The message being continued, at the end of the prompt. */
  continuePrompt: string;
  /** Text of the message being continued (SillyTavern `continue_mag`). */
  continued: string;
  /** Chat messages and example blocks that fit. */
  messageCount: number;
  exampleCount: number;
}

/** Picked so that it never occurs in a message. */
const FORMAT_TOKEN = '\u0000￼\u0000�';

export async function buildTextCompletion(input: TextCompletionInput): Promise<TextCompletionResult> {
  const { type, instruct, context, substitute, userName: name1, charName: name2 } = input;
  const isInstruct = input.instructEnabled;
  const isImpersonate = type === 'impersonate';
  const isContinue = type === 'continue';
  const ext = input.extensionPrompts;
  const f: InstructContext = {
    instruct,
    context,
    userName: name1,
    charName: name2,
    isGroup: Boolean(input.isGroup),
    groupNames: input.groupNames,
    substitute,
  };
  const countTokens = async (text: string, padding = 0) =>
    text.length ? (await input.countTokens(text)) + padding : 0;
  const extensionPrompt = (
    position: number,
    options: { depth?: number; role?: number; wrap?: boolean } = {},
  ) => {
    const value = joinExtensionPrompts(ext, position, options);
    return value.length ? substitute(value) : value;
  };

  // Examples in instruct format
  const examplesRaw = [...input.examples];
  let examples = isInstruct ? formatInstructExamples(f, input.examples) : [...input.examples];

  // Story string
  const anchorBefore = extensionPrompt(ExtensionPromptPosition.BEFORE_PROMPT);
  const anchorAfter = extensionPrompt(ExtensionPromptPosition.IN_PROMPT);
  const storyString = await renderStoryString(f, isInstruct, {
    ...input.story,
    char: name2,
    user: name1,
    loreBefore: input.story.wiBefore,
    loreAfter: input.story.wiAfter,
    anchorBefore: anchorBefore.trim(),
    anchorAfter: anchorAfter.trim(),
    mesExamples: examples.join(''),
    mesExamplesRaw: examplesRaw.join(''),
  });
  let combinedStoryString = isInstruct ? formatInstructStoryString(f, storyString) : storyString;
  if (context.story_string_position === ExtensionPromptPosition.IN_CHAT) {
    ext[InjectKeys.STORY_STRING] = {
      value: combinedStoryString,
      position: ExtensionPromptPosition.IN_CHAT,
      depth: context.story_string_depth ?? 1,
      scan: false,
      role: context.story_string_role ?? ExtensionPromptRole.SYSTEM,
    };
    combinedStoryString = '';
  } else {
    ext[InjectKeys.STORY_STRING] = {
      value: '',
      position: ExtensionPromptPosition.IN_CHAT,
      depth: 0,
      scan: false,
      role: ExtensionPromptRole.SYSTEM,
    };
  }
  if (input.stripExamples) examples = [];

  // In-chat injections (`doChatInject`), on the newest-first list
  const coreChat = [...input.messages];
  const reversed = coreChat.reverse();
  const injected: TextCompletionMessage[] = [];
  let inserted = 0;
  const depths = [
    ...new Set(
      Object.values(ext)
        .filter((p) => p.position === ExtensionPromptPosition.IN_CHAT && p.value)
        .map((p) => p.depth),
    ),
  ]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= MAX_INJECTION_DEPTH)
    .sort((a, b) => a - b);
  for (const depth of depths) {
    const roleMessages: TextCompletionMessage[] = [];
    for (const role of [
      ExtensionPromptRole.SYSTEM,
      ExtensionPromptRole.USER,
      ExtensionPromptRole.ASSISTANT,
    ]) {
      const value = extensionPrompt(ExtensionPromptPosition.IN_CHAT, {
        depth,
        role,
        wrap: false,
      }).trimStart();
      if (!value) continue;
      roleMessages.push({
        name: role === ExtensionPromptRole.SYSTEM ? '' : role === ExtensionPromptRole.USER ? name1 : name2,
        isUser: role === ExtensionPromptRole.USER,
        isNarrator: role === ExtensionPromptRole.SYSTEM,
        mes: value,
      });
    }
    if (!roleMessages.length) continue;
    const at = Math.min((isContinue && depth === 0 ? 1 : depth) + inserted, reversed.length);
    reversed.splice(at, 0, ...roleMessages);
    inserted += roleMessages.length;
    injected.push(...roleMessages);
  }
  let injectedIndices = injected.map((m) => reversed.indexOf(m));
  reversed.reverse();
  const chat = reversed;

  // Post-history instructions go after the last message (before the one being continued).
  if (input.postHistory) {
    const message = { mes: input.postHistory, isUser: true, isNarrator: false };
    if (isContinue) chat.splice(chat.length - 1, 0, message);
    else {
      chat.push(message);
      injectedIndices = injectedIndices.map((i) => i + 1);
    }
  }

  const formatItem = (item: TextCompletionMessage, forceSequence: number | false) => {
    const itemName = item.isUser ? item.name : item.name || name2;
    if (isInstruct) {
      return formatInstructChat(
        f,
        {
          name: itemName ?? '',
          mes: item.mes,
          isUser: item.isUser,
          isNarrator: item.isNarrator,
          forceAvatar: item.forceAvatar,
        },
        forceSequence,
      );
    }
    return item.name && !item.isNarrator ? `${itemName}: ${item.mes}\n` : `${item.mes}\n`;
  };

  // Chat history, newest first
  const chat2: string[] = [];
  let continued = '';
  let userMessageIndices: number[] = [];
  const lastUserIndex = chat.findLastIndex((m) => m.isUser);
  for (let i = chat.length - 1, j = 0; i >= 0; i--, j++) {
    const item = chat[j]!;
    chat2[i] = formatItem(item, false);
    if (j === 0 && isInstruct) chat2[i] = formatItem(item, ForceSequence.FIRST);
    if (lastUserIndex >= 0 && j === lastUserIndex && isInstruct && !isImpersonate) {
      chat2[i] = formatItem(item, ForceSequence.LAST);
    }
    // The continued message gets no suffix.
    if (i === 0 && isContinue) {
      if (isInstruct) {
        chat2[i] = formatItem(
          { ...item, mes: item.mes.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN },
          ForceSequence.LAST,
        );
      }
      chat2[i] = chat2[i]!.includes(FORMAT_TOKEN)
        ? chat2[i]!.slice(0, chat2[i]!.lastIndexOf(FORMAT_TOKEN))
        : chat2[i]!.slice(0, chat2[i]!.lastIndexOf(item.mes) + item.mes.length);
      continued = item.mes;
    }
    if (item.isUser) userMessageIndices.push(i);
  }

  const addUserAlignment = isInstruct && Boolean(instruct.user_alignment_message);
  const userAlignmentMessage = addUserAlignment
    ? formatItem(
        { name: name1, mes: substitute(instruct.user_alignment_message), isUser: true, isNarrator: false },
        ForceSequence.FIRST,
      )
    : '';

  if (chat2.length === 0) chat2.push('');

  const chatSeparator = (text: string) =>
    context.chat_start ? substitute(`${context.chat_start}\n`) + text : text;

  // The line that starts the reply (`modifyLastPromptLine`)
  const quietPrompt = input.quietPrompt ?? '';
  const isContinuingOnFirstMessage = input.chatLength === 1 && isContinue;
  const lastPromptLine = (last: string) => {
    if (quietPrompt) {
      last += isInstruct
        ? formatInstructChat(f, { name: name1, mes: quietPrompt, isUser: false, isNarrator: true }, false)
        : `\n${quietPrompt}`;
      if (!isInstruct && !input.quietToLoud) return last;
    }
    if (isInstruct && !isContinue) {
      const name =
        quietPrompt && !input.quietToLoud && !isImpersonate
          ? (input.quietName ?? 'System')
          : isImpersonate
            ? name1
            : name2;
      last += formatInstructPrompt(f, {
        name,
        isImpersonate,
        promptBias: input.promptBias,
        isQuiet: Boolean(quietPrompt) && type === 'quiet',
        isQuietToLoud: Boolean(input.quietToLoud),
      });
    }
    if (!isInstruct && isImpersonate && !isContinue) {
      if (!last.endsWith('\n')) last += '\n';
      last += `${name1}:`;
    }
    if (!isInstruct && input.forceName2 && !isContinuingOnFirstMessage) {
      if (!last.endsWith('\n')) last += '\n';
      if (!isContinue || !input.lastIsUser) last += `${name2}:`;
    }
    return last;
  };

  let examplesString = '';
  let chatString = chatSeparator('');
  let cyclePrompt = '';
  const messagesTokenCount = async () =>
    countTokens(
      [combinedStoryString, examplesString, userAlignmentMessage, chatString, lastPromptLine(''), cyclePrompt]
        .join('')
        .replace(/\r/gm, ''),
      input.tokenPadding,
    );

  let pinnedExamples: string | undefined;
  if (input.pinExamples) pinnedExamples = examplesString = examples.join('');

  if (isContinue && chat2.length > 1) {
    cyclePrompt = chat2.shift()!;
    injectedIndices = injectedIndices.map((i) => i - 1).filter((i) => i >= 0);
    userMessageIndices = userMessageIndices.map((i) => i - 1).filter((i) => i >= 0);
  }

  // Messages that fit: injections first, then from the newest.
  let arrMes: (string | undefined)[] = new Array<string | undefined>(chat2.length);
  let tokenCount = await messagesTokenCount();
  let lastAddedIndex = 0;
  const maxTokens = input.maxPromptTokens;
  for (const index of injectedIndices) {
    const item = chat2[index];
    if (typeof item !== 'string') continue;
    tokenCount += await countTokens(item.replace(/\r/gm, ''));
    if (tokenCount >= maxTokens) break;
    chatString += item;
    arrMes[index] = item;
    lastAddedIndex = Math.max(lastAddedIndex, index);
  }
  for (let i = 0; i < chat2.length; i++) {
    if (arrMes[i] !== undefined) continue;
    const item = chat2[i];
    if (typeof item !== 'string') continue;
    tokenCount += await countTokens(item.replace(/\r/gm, ''));
    if (tokenCount >= maxTokens) break;
    chatString += item;
    arrMes[i] = item;
    lastAddedIndex = Math.max(lastAddedIndex, i);
  }

  // The user alignment message goes first unless the history already starts with the user.
  if (addUserAlignment && !userMessageIndices.includes(lastAddedIndex)) {
    chatString = userAlignmentMessage + chatString;
    arrMes.push(userAlignmentMessage);
    injectedIndices.push(arrMes.length - 1);
  }

  const packed: string[] = [];
  const packedInjected: number[] = [];
  for (let i = 0; i < arrMes.length; i++) {
    if (arrMes[i] === undefined) continue;
    packed.push(arrMes[i]!);
    if (injectedIndices.includes(i)) packedInjected.push(packed.length - 1);
  }
  arrMes = packed;

  // Examples that fit
  tokenCount = await messagesTokenCount();
  let exampleCount = 0;
  if (!input.pinExamples) {
    for (const example of examples) {
      tokenCount += await countTokens(example.replace(/\r/gm, ''));
      examplesString += example;
      if (tokenCount < maxTokens) exampleCount++;
      else break;
    }
  }

  // Oldest first; the last message loses its trailing newline (the prompt line adds one).
  const mesSend: { message: string; extensionPrompts: string[] }[] = [];
  arrMes.reverse().forEach((item, i, all) => {
    let message = item!;
    if (i === all.length - 1 && type !== 'continue') {
      if (!isInstruct || (instruct.wrap && type !== 'quiet')) message = message.replace(/\n?$/, '');
    }
    mesSend.push({ message, extensionPrompts: [] });
  });

  let mesExmString = '';
  const setPromptString = () => {
    mesExmString = pinnedExamples ?? examples.slice(0, exampleCount).join('');
    // Like SillyTavern, every pass appends the prompt line again.
    if (mesSend.length)
      mesSend[mesSend.length - 1]!.message = lastPromptLine(mesSend[mesSend.length - 1]!.message);
  };
  const checkPromptSize = async (): Promise<void> => {
    setPromptString();
    const joint = mesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');
    const prompt = [
      combinedStoryString,
      mesExmString,
      chatSeparator(joint),
      '\n',
      lastPromptLine(''),
      cyclePrompt,
    ]
      .join('')
      .replace(/\r/gm, '');
    if ((await countTokens(prompt, input.tokenPadding)) > maxTokens) {
      if (exampleCount > 0) {
        exampleCount--;
        await checkPromptSize();
      } else if (mesSend.length > 0) {
        mesSend.shift();
        await checkPromptSize();
      }
    }
  };
  if (cyclePrompt.length > 0) await checkPromptSize();
  else setPromptString();

  // "Start reply with" goes after everything else (non-instruct).
  const finalMesSend = mesSend.map((m) => ({ ...m, extensionPrompts: [...m.extensionPrompts] }));
  const last = finalMesSend.at(-1);
  if (!isInstruct && !isImpersonate && input.promptBias.trim().length !== 0 && last) {
    last.message += /\s/.test(last.message.slice(-1))
      ? input.promptBias.trimStart()
      : ` ${input.promptBias.trimStart()}`;
  }
  const mesSendString = chatSeparator(
    finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join(''),
  );
  let prompt = [combinedStoryString, mesExmString, mesSendString, cyclePrompt].join('').replace(/\r/gm, '');
  if (input.collapseNewlines) prompt = prompt.replaceAll(/\n+/g, '\n');

  return {
    prompt,
    storyString,
    examples: mesExmString,
    messages: mesSendString,
    continuePrompt: cyclePrompt,
    continued,
    messageCount: arrMes.length - packedInjected.length,
    exampleCount: pinnedExamples !== undefined ? examples.length : exampleCount,
  };
}
