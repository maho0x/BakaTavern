/**
 * Generation orchestration for Chat Completion APIs — the parts of SillyTavern's `Generate()`
 * that decide what goes into the prompt: card fields, Author's Note, character and persona
 * injections, World Info, example dialogues, then `buildChatCompletion` and the provider request.
 */

import { cardData, type CardData } from '../model/card.ts';
import { objectVariables, type MacroEngine, type MacroEnv } from '../macros/index.ts';
import {
  buildChatCompletion,
  buildTextCompletion,
  defaultContextTemplate,
  defaultInstructTemplate,
  defaultReasoningPromptSettings,
  defaultSystemPrompt,
  examplesToMessages,
  ExtensionPromptPosition,
  ExtensionPromptRole,
  formatInstructExamples,
  InjectKeys,
  instructStoppingSequences,
  joinExtensionPrompts,
  parseMesExamples,
  postProcessPrompt,
  PromptReasoning,
  toPromptMessages,
  withAttachmentText,
  messageAttachments,
  imageInliningSupported,
  videoInliningSupported,
  audioInliningSupported,
  compressImageSources,
  type ChatCompletionPreset,
  type MediaInlining,
  type MediaResolver,
  type ModelListEntry,
  type ChatCompletionResult,
  type ContextTemplate,
  type ExtensionPrompt,
  type GenerationType,
  type HistoryMessage,
  type InstructContext,
  type InstructTemplate,
  type ReasoningPromptSettings,
  type SystemPromptTemplate,
  type TextCompletionResult,
} from '../prompt/index.ts';
import { getRegexedString, RegexPlacement, type RegexScript, type RegexSubstitute } from '../regex/index.ts';
import {
  canCallTools,
  reasoningSignatureSupported,
  TOOL_RECURSE_LIMIT,
  toolCallingSupported,
  toolReasoningMode,
  type ToolDefinition,
  type ToolInvocation,
} from '../tools.ts';
import {
  adapterFor,
  chatStreams,
  excludeFromYaml,
  includeFromYaml,
  textgenGenerateData,
  textgenModel,
  textgenRequest,
  textgenTokenizationNeeds,
  type GenerationRequest,
  type HttpRequestSpec,
  type ProviderDefinition,
  type TextgenSettings,
} from '../providers/index.ts';
import {
  chatLogitBias,
  chatTextCounter,
  messageTokenCounter,
  textCounter,
  TokenCache,
  type Tokenizer,
} from '../tokenizers/index.ts';
import { collapseNewlines } from '../util/text.ts';
import {
  collectEntries,
  scanWorldInfo,
  type LoadedBook,
  type TimedWorldInfoState,
  type WorldInfoScanResult,
  type WorldInfoSettings,
} from '../worldinfo/index.ts';

/** Persona description positions (SillyTavern `persona_description_positions`). */
export const PersonaPosition = { IN_PROMPT: 0, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 } as const;

export interface PersonaInfo {
  name: string;
  description: string;
  position: number;
  depth: number;
  role: number;
}

/** A chat message as stored (only the fields generation needs). */
export interface StoredMessage {
  name: string;
  role: 'user' | 'assistant' | 'system';
  hidden: boolean;
  /** Active swipe text. */
  content: string;
  swipeId: number;
  swipeCount: number;
  extra: Record<string, unknown>;
  forceAvatar?: boolean;
}

export interface AuthorsNoteSettings {
  /** Character-specific note: replaces (0), goes before (1) or after (2) the chat note. */
  characterNote?: { prompt: string; position: number; enabled: boolean };
  /** Include the note in World Info scanning. */
  allowWIScan: boolean;
}

export interface ConnectionInfo {
  provider: ProviderDefinition;
  model: string;
  baseUrl?: string;
  secretId?: string;
  /** Source options with SillyTavern's keys (`openrouter_middleout`, `zai_endpoint`, ...). */
  settings?: Record<string, unknown>;
  /** Custom source: YAML for extra body fields, removed body keys and extra headers (macros allowed). */
  customBody?: { include?: string; exclude?: string; headers?: string };
}

/**
 * SillyTavern's "Advanced Formatting": instruct and context templates, the system prompt and the
 * power user options that shape the prompt. Text Completion builds the prompt with them; macros
 * (`{{systemPrompt}}`, `{{instructInput}}`, `{{chatStart}}` ...) read them with either API.
 */
export interface FormattingSettings {
  instructEnabled: boolean;
  instruct: InstructTemplate;
  context: ContextTemplate;
  syspromptEnabled: boolean;
  sysprompt: SystemPromptTemplate;
  /** Use the card's system prompt / post-history instructions over the global ones. */
  preferCharacterPrompt: boolean;
  preferCharacterJailbreak: boolean;
  collapseNewlines: boolean;
  /** Tokens added to the prompt size estimate (SillyTavern `token_padding`). */
  tokenPadding: number;
  /** Leave example dialogues out of the history (still available to the story string). */
  stripExamples: boolean;
}

export const defaultFormattingSettings: FormattingSettings = {
  instructEnabled: false,
  instruct: defaultInstructTemplate,
  context: defaultContextTemplate,
  syspromptEnabled: true,
  sysprompt: defaultSystemPrompt,
  preferCharacterPrompt: true,
  preferCharacterJailbreak: true,
  collapseNewlines: false,
  tokenPadding: 64,
  stripExamples: false,
};

/** A Text Completion connection and its settings. */
export interface TextCompletionSetup {
  /** SillyTavern Text Completion settings: the preset's samplers plus type, server and model. */
  settings: TextgenSettings;
  /** Context size and response length (SillyTavern `max_context`, `amount_gen`). */
  maxContext: number;
  maxResponse: number;
  secretId?: string;
  /** Gives token ids for banned tokens and logit bias (SillyTavern's tokenizer for token ids). */
  idTokenizer?: Tokenizer;
  /** Ask for token probabilities. */
  logprobs?: boolean;
}

interface CommonOptions {
  type: GenerationType;
  card: unknown;
  /** Character avatar file name without extension (SillyTavern's character key for filters). */
  characterKey: string;
  characterTags: readonly string[];
  persona: PersonaInfo;
  chatId: string;
  /** SillyTavern `chat_metadata` (variables, Author's Note, World Info timers ...). Mutated. */
  chatMetadata: Record<string, unknown>;
  messages: readonly StoredMessage[];
  worldInfo: {
    settings: WorldInfoSettings;
    global: readonly LoadedBook[];
    character: readonly LoadedBook[];
    chat?: LoadedBook | null;
    persona?: LoadedBook | null;
  };
  authorsNote: AuthorsNoteSettings;
  globalVariables: Record<string, unknown>;
  tokenizer: Tokenizer;
  macros: MacroEngine;
  /** Advanced formatting; SillyTavern's defaults when missing. */
  formatting?: FormattingSettings;
  quietPrompt?: string;
  /** Text Completion quiet prompts: reply in character instead of as the system. */
  quietToLoud?: boolean;
  quietName?: string;
  /** Put the character's name before the reply (quiet generations force it). */
  forceName2?: boolean;
  /** Extra injections from plugins, keyed like SillyTavern extension prompts. */
  extraInjections?: Record<string, ExtensionPrompt>;
  /** "Start reply with" (SillyTavern `user_prompt_bias`). */
  promptBias?: string;
  stoppingStrings?: readonly string[];
  /** Regex scripts in effect, ordered and filtered (see `activeRegexScripts`). */
  regexScripts?: readonly RegexScript[];
  /** Adding the reasoning of past replies to the prompt (SillyTavern `power_user.reasoning`). */
  reasoning?: ReasoningPromptSettings;
  /** Keep example dialogues even when the context is full (SillyTavern `pin_examples`). */
  pinExamples?: boolean;
  /** Loads attachments (file text, inlined media); without it they stay out of the prompt. */
  attachments?: MediaResolver;
  /** How messages show their media when none is set (SillyTavern `power_user.media_display`). */
  mediaDisplay?: 'list' | 'gallery';
  now?: () => Date;
  random?: () => number;
  dryRun?: boolean;
}

export interface ChatCompletionOptions extends CommonOptions {
  api?: 'chat';
  preset: ChatCompletionPreset;
  connection: ConnectionInfo;
  /** The preset's logit bias list (SillyTavern `bias_presets[bias_preset_selected]`). */
  logitBias?: readonly { text?: string; value?: number }[];
  /** The model's entry in its provider's model list (what it accepts inline). */
  modelInfo?: ModelListEntry;
  /** Function tools the model may call (when the preset allows it). */
  tools?: readonly ToolDefinition[];
  /** Rounds of tool calls before this generation (they stop at `TOOL_RECURSE_LIMIT`). */
  toolDepth?: number;
}

export interface TextCompletionOptions extends CommonOptions {
  api: 'text';
  text: TextCompletionSetup;
}

export type PrepareOptions = ChatCompletionOptions | TextCompletionOptions;

interface PreparedCommon {
  http: HttpRequestSpec;
  stream: boolean;
  worldInfo: WorldInfoScanResult;
  extensionPrompts: Record<string, ExtensionPrompt>;
  env: MacroEnv;
  /** Strings that end the reply. */
  stoppingStrings: string[];
  /**
   * Reasoning put before the continued message. `incomplete` means that message had no text yet,
   * so the model continues the reasoning itself.
   */
  reasoningPrefix?: { text: string; incomplete: boolean };
  /** Macro substitution for regex scripts with this generation's environment. */
  regexSubstitute: RegexSubstitute;
  /** The model the request names. */
  model: string;
}

export interface PreparedChatCompletion extends PreparedCommon {
  api: 'chat';
  request: GenerationRequest;
  prompt: ChatCompletionResult;
}

export interface PreparedTextCompletion extends PreparedCommon {
  api: 'text';
  /** The body SillyTavern's client would send (before the server's per-backend changes). */
  data: Record<string, unknown>;
  prompt: TextCompletionResult;
}

export type PreparedGeneration = PreparedChatCompletion | PreparedTextCompletion;

function roleId(role: string | number | undefined): number {
  if (typeof role === 'number') return role;
  if (role === 'user') return ExtensionPromptRole.USER;
  if (role === 'assistant') return ExtensionPromptRole.ASSISTANT;
  return ExtensionPromptRole.SYSTEM;
}

/** Context size and response length in effect. */
function contextLimits(options: PrepareOptions): { maxContext: number; maxResponse: number } {
  return options.api === 'text'
    ? { maxContext: options.text.maxContext, maxResponse: options.text.maxResponse }
    : { maxContext: options.preset.openai_max_context, maxResponse: options.preset.openai_max_tokens };
}

function modelOf(options: PrepareOptions): string {
  if (options.api !== 'text') return options.connection.model;
  try {
    return textgenModel(options.text.settings) ?? '';
  } catch {
    return '';
  }
}

export function macroEnvFor(options: PrepareOptions, card: CardData): MacroEnv {
  const local = (options.chatMetadata.variables ??= {}) as Record<string, unknown>;
  const { maxContext, maxResponse } = contextLimits(options);
  const formatting = options.formatting ?? defaultFormattingSettings;
  return {
    user: options.persona.name,
    char: card.name,
    description: card.description,
    personality: card.personality,
    scenario: String(options.chatMetadata.scenario || card.scenario),
    persona: options.persona.description,
    mesExamplesRaw: String(options.chatMetadata.mes_example || card.mes_example),
    charPrompt: String(options.chatMetadata.system_prompt || card.system_prompt),
    charInstruction: card.post_history_instructions,
    charDepthPrompt: card.extensions.depth_prompt?.prompt ?? '',
    creatorNotes: card.creator_notes,
    charVersion: card.character_version,
    firstMessage: card.first_mes,
    alternateGreetings: card.alternate_greetings,
    model: modelOf(options),
    lastGenerationType: options.type,
    maxContextTokens: maxContext,
    maxResponseTokens: maxResponse,
    maxPromptTokens: maxContext - maxResponse,
    messages: options.messages.map((m) => ({
      name: m.name,
      role: m.role,
      hidden: m.hidden,
      text: m.content,
      swipeId: m.swipeId,
      swipeCount: m.swipeCount,
    })),
    localVariables: objectVariables(local),
    globalVariables: objectVariables(options.globalVariables),
    chatId: options.chatId,
    now: options.now,
    random: options.random,
    instruct: formatting.instructEnabled ? formatting.instruct : undefined,
    sysprompt: formatting.syspromptEnabled ? formatting.sysprompt : undefined,
    preferCharacterPrompt: formatting.preferCharacterPrompt,
    chatStart: formatting.context.chat_start,
    exampleSeparator: formatting.context.example_separator,
    bannedWords: [],
  };
}

/**
 * "Start reply with" for this generation (SillyTavern `getBiasStrings`): none when continuing or
 * impersonating; otherwise the bias of the latest user or narrator message, or the global one.
 */
function promptBiasFor(options: PrepareOptions): { promptBias: string; isUserPromptBias: boolean } {
  if (options.type === 'impersonate' || options.type === 'continue')
    return { promptBias: '', isUserPromptBias: false };
  let messageBias = '';
  const messages = options.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (options.type === 'swipe' && i === messages.length - 1) continue;
    if (m.role === 'user' || m.role === 'system' || m.hidden) {
      const bias = m.extra.bias;
      if (typeof bias === 'string' && bias.trim().length > 0) messageBias = bias;
      break;
    }
  }
  const userBias = options.promptBias ?? '';
  const promptBias = messageBias || userBias;
  return { promptBias, isUserPromptBias: promptBias === userBias };
}

export async function prepareGeneration(options: ChatCompletionOptions): Promise<PreparedChatCompletion>;
export async function prepareGeneration(options: TextCompletionOptions): Promise<PreparedTextCompletion>;
export async function prepareGeneration(options: PrepareOptions): Promise<PreparedGeneration>;
export async function prepareGeneration(options: PrepareOptions): Promise<PreparedGeneration> {
  const card = cardData(options.card);
  const { macros, type } = options;
  const isText = options.api === 'text';
  const formatting = options.formatting ?? defaultFormattingSettings;
  const isInstruct = isText && formatting.instructEnabled;
  const env = macroEnvFor(options, card);
  const substitute = (text: string, extra?: { original?: string }) =>
    macros.evaluate(text, extra?.original !== undefined ? { ...env, original: extra.original } : env);
  // Card fields are expanded without the card macros themselves (SillyTavern `baseChatReplace`).
  const cardEnv: MacroEnv = {
    ...env,
    description: '',
    personality: '',
    scenario: '',
    persona: '',
    mesExamples: '',
    mesExamplesRaw: '',
  };
  const chatReplace = (text: string) => {
    if (!text) return text;
    let value = macros.evaluate(text, cardEnv);
    if (formatting.collapseNewlines) value = collapseNewlines(value);
    return value.replace(/\r/g, '');
  };
  const base = (text: string) => (text ? chatReplace(text.trim()) : '');

  const description = base(card.description);
  const personality = base(card.personality);
  const scenario = base(String(options.chatMetadata.scenario || card.scenario));
  const personaText = base(options.persona.description);
  const examplesText = base(String(options.chatMetadata.mes_example || card.mes_example));
  const systemPrompt = formatting.preferCharacterPrompt
    ? base(String(options.chatMetadata.system_prompt || card.system_prompt))
    : '';
  const jailbreak = formatting.preferCharacterJailbreak ? base(card.post_history_instructions) : '';
  const depthPrompt = base(card.extensions.depth_prompt?.prompt ?? '');
  Object.assign(env, {
    description,
    personality,
    scenario,
    persona: personaText,
    mesExamplesRaw: examplesText,
    charPrompt: systemPrompt,
    charInstruction: jailbreak,
  });

  const ext: Record<string, ExtensionPrompt> = { ...options.extraInjections };
  const set = (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan = false,
    role: number = ExtensionPromptRole.SYSTEM,
  ) => {
    ext[key] = { value, position, depth, scan, role };
  };

  // Character depth prompt (character's note)
  const dp = card.extensions.depth_prompt;
  set(
    InjectKeys.DEPTH_PROMPT,
    depthPrompt,
    ExtensionPromptPosition.IN_CHAT,
    dp?.depth ?? 4,
    options.authorsNote.allowWIScan,
    roleId(dp?.role),
  );

  // Messages that enter the prompt, with regex scripts and past reasoning applied
  const isContinue = type === 'continue';
  const scripts = options.regexScripts ?? [];
  const regexSubstitute: RegexSubstitute = (text, extra) =>
    macros.evaluate(text, {
      ...env,
      ...(extra?.charName !== undefined ? { char: extra.charName } : {}),
      postProcess: extra?.postProcess,
    });
  // The first message follows changes to the persona and card: SillyTavern substitutes macros in
  // `chat[0]` before every generation.
  const canUseTools =
    options.api !== 'text' &&
    toolCallingSupported(
      options.connection.provider.id,
      options.connection.model,
      options.preset,
      options.modelInfo,
    );
  let core = options.messages
    .map((m, i) => (i === 0 ? { ...m, content: substitute(m.content) } : m))
    // Hidden messages stay out, except the ones recording tool calls when the model can call tools.
    .filter((m) => !m.hidden || (canUseTools && Array.isArray(m.extra.tool_invocations)));
  if (type === 'swipe') core = core.slice(0, -1);
  core = await Promise.all(
    core.map(async (m, index) => ({
      ...m,
      // Attached files' text goes before the message, attachment titles after it.
      content: await withAttachmentText(
        getRegexedString(
          m.content,
          m.role === 'user' ? RegexPlacement.USER_INPUT : RegexPlacement.AI_OUTPUT,
          scripts,
          regexSubstitute,
          { isPrompt: true, depth: core.length - index - (isContinue ? 2 : 1) },
        ),
        m.extra,
        options.attachments ? (url) => options.attachments!.fileText(url) : undefined,
      ),
    })),
  );
  const promptReasoning = new PromptReasoning(options.reasoning ?? defaultReasoningPromptSettings, (text) =>
    substitute(text),
  );
  for (let i = core.length - 1; i >= 0; i--) {
    const message = core[i]!;
    const reasoningText = getRegexedString(
      String(message.extra.reasoning ?? ''),
      RegexPlacement.REASONING,
      scripts,
      regexSubstitute,
      { isPrompt: true, depth: core.length - i - (isContinue ? 2 : 1) },
    );
    const isPrefix = isContinue && i === core.length - 1;
    core[i] = { ...message, content: promptReasoning.addToMessage(message.content, reasoningText, isPrefix) };
    if (promptReasoning.isLimitReached()) break;
  }

  const { promptBias: rawBias, isUserPromptBias } = promptBiasFor(options);
  const promptBias = rawBias ? substitute(rawBias) : '';
  const quietPrompt = options.quietPrompt ? substitute(options.quietPrompt) : '';

  // Author's Note (SillyTavern `setFloatingPrompt`)
  const meta = options.chatMetadata;
  const interval = Number(meta.note_interval ?? 1);
  const notePosition = Number(meta.note_position ?? ExtensionPromptPosition.IN_CHAT);
  const noteDepth = Number(meta.note_depth ?? 4);
  const noteRole = Number(meta.note_role ?? 0);
  let userCount = options.messages.filter((m) => m.role === 'user').length;
  if (interval === 1) userCount = 1;
  let anActive = false;
  if (userCount > 0 && interval > 0) {
    const tillInsertion = userCount >= interval ? userCount % interval : interval - userCount;
    anActive = tillInsertion === 0;
  }
  let note = anActive ? String(meta.note_prompt ?? '') : '';
  const charNote = options.authorsNote.characterNote;
  if (anActive && charNote?.enabled) {
    note =
      charNote.position === 1
        ? `${charNote.prompt}\n${note}`
        : charNote.position === 2
          ? `${note}\n${charNote.prompt}`
          : charNote.prompt;
  }
  set(
    InjectKeys.AUTHORS_NOTE,
    note,
    anActive ? notePosition : ExtensionPromptPosition.NONE,
    noteDepth,
    options.authorsNote.allowWIScan,
    noteRole,
  );

  // World Info
  const wiSettings = options.worldInfo.settings;
  const chatForScan = core
    .map((m) => (wiSettings.includeNames ? `${m.name}: ${m.content}` : m.content))
    .reverse();
  if (quietPrompt) set(InjectKeys.QUIET_PROMPT, quietPrompt, ExtensionPromptPosition.IN_PROMPT, 0, true);
  const injects = Object.keys(ext)
    .filter((k) => ext[k]!.scan && ext[k]!.value)
    .map((k) => substitute(ext[k]!.value));
  const entries = collectEntries(
    {
      global: options.worldInfo.global,
      character: options.worldInfo.character,
      chat: options.worldInfo.chat,
      persona: options.worldInfo.persona,
    },
    wiSettings.characterStrategy,
  );
  const counter = new TokenCache();
  // Text Completion counts plain text; Chat Completion counts text as a message (World Info).
  const countText = isText
    ? textCounter(options.tokenizer, counter)
    : chatTextCounter(options.tokenizer, counter);
  const { maxContext, maxResponse } = contextLimits(options);
  const maxPrompt = maxContext - maxResponse;
  const worldInfo = await scanWorldInfo({
    chat: chatForScan,
    entries,
    settings: wiSettings,
    maxContext: maxPrompt,
    global: {
      personaDescription: personaText,
      characterDescription: description,
      characterPersonality: personality,
      characterDepthPrompt: depthPrompt,
      scenario,
      creatorNotes: base(card.creator_notes),
      trigger: type,
    },
    injects,
    timedState: (meta.timedWorldInfo ??= {}) as TimedWorldInfoState,
    dryRun: options.dryRun,
    character: { fileName: options.characterKey, tags: options.characterTags },
    substitute,
    countTokens: countText,
    applyRegex: scripts.length
      ? (text, depth) =>
          getRegexedString(text, RegexPlacement.WORLD_INFO, scripts, regexSubstitute, {
            depth,
            isMarkdown: false,
            isPrompt: true,
          })
      : undefined,
    random: options.random,
  });
  if (quietPrompt) delete ext[InjectKeys.QUIET_PROMPT];

  if (anActive) {
    const withWI = `${worldInfo.anTop.join('\n')}\n${note}\n${worldInfo.anBottom.join('\n')}`.replace(
      /(^\n)|(\n$)/g,
      '',
    );
    set(InjectKeys.AUTHORS_NOTE, withWI, notePosition, noteDepth, options.authorsNote.allowWIScan, noteRole);
  }
  for (const d of worldInfo.depth) {
    set(
      InjectKeys.worldInfoDepth(d.depth, d.role),
      d.entries.join('\n'),
      ExtensionPromptPosition.IN_CHAT,
      d.depth,
      false,
      d.role,
    );
  }
  env.outlets = Object.fromEntries(Object.entries(worldInfo.outlets).map(([k, v]) => [k, v.join('\n')]));

  // Persona description placement
  const persona = options.persona;
  let personaInPrompt = '';
  if (personaText && persona.position !== PersonaPosition.NONE) {
    if (persona.position === PersonaPosition.IN_PROMPT) personaInPrompt = personaText;
    if (
      (persona.position === PersonaPosition.TOP_AN || persona.position === PersonaPosition.BOTTOM_AN) &&
      anActive
    ) {
      const current = ext[InjectKeys.AUTHORS_NOTE]!.value;
      const merged =
        persona.position === PersonaPosition.TOP_AN
          ? `${personaText}\n${current}`
          : `${current}\n${personaText}`;
      set(
        InjectKeys.AUTHORS_NOTE,
        merged,
        notePosition,
        noteDepth,
        options.authorsNote.allowWIScan,
        noteRole,
      );
    }
    if (persona.position === PersonaPosition.AT_DEPTH) {
      set(
        InjectKeys.PERSONA_DESCRIPTION,
        personaText,
        ExtensionPromptPosition.IN_CHAT,
        persona.depth,
        true,
        persona.role,
      );
    }
  }

  // Example dialogues (+ World Info example entries). Text Completion without instruct mode
  // heads each block with the context template's separator.
  const exampleHeading =
    !isText || isInstruct
      ? '<START>\n'
      : formatting.context.example_separator
        ? `${substitute(formatting.context.example_separator)}\n`
        : '';
  const cardBlocks = parseMesExamples(examplesText, exampleHeading);
  const blocks = [...cardBlocks];
  for (const example of worldInfo.examples) {
    if (!example.content) continue;
    const parsed = parseMesExamples(base(example.content), exampleHeading);
    if (example.position === 'before') blocks.unshift(...parsed);
    else blocks.push(...parsed);
  }
  const instructContext: InstructContext = {
    instruct: formatting.instruct,
    context: formatting.context,
    userName: persona.name,
    charName: card.name,
    isGroup: false,
    substitute: (text, names) => (names ? macros.evaluate(text, { ...env, ...names }) : substitute(text)),
  };
  env.mesExamples = (isInstruct ? formatInstructExamples(instructContext, cardBlocks) : cardBlocks).join('');

  const common = {
    worldInfo,
    extensionPrompts: ext,
    env,
    regexSubstitute,
    model: modelOf(options),
    reasoningPrefix:
      promptReasoning.prefixLength > 0
        ? { text: promptReasoning.prefixFormatted, incomplete: promptReasoning.prefixIncomplete }
        : undefined,
  };
  const customStops = (options.stoppingStrings ?? []).filter((s) => s.length > 0).map((s) => substitute(s));

  if (options.api === 'text') {
    const { text } = options;
    const isImpersonate = type === 'impersonate';
    const context = formatting.context;

    // System prompt and post-history instructions: the card's or the global ones.
    let system = '';
    let postHistory = '';
    if (formatting.syspromptEnabled) {
      const original = formatting.sysprompt.content ?? '';
      system =
        formatting.preferCharacterPrompt && systemPrompt
          ? substitute(systemPrompt, { original })
          : chatReplace(formatting.sysprompt.content);
      if (isInstruct) system = substitute(system, { original });
      postHistory =
        formatting.preferCharacterJailbreak && jailbreak
          ? substitute(jailbreak, { original: formatting.sysprompt.post_history ?? '' })
          : chatReplace(formatting.sysprompt.post_history);
    }

    let forceName2 = Boolean(options.forceName2);
    if ((promptBias && !isUserPromptBias) || context.always_force_name2) forceName2 = true;
    if (isImpersonate) forceName2 = false;

    const prompt = await buildTextCompletion({
      type,
      userName: persona.name,
      charName: card.name,
      instructEnabled: isInstruct,
      instruct: formatting.instruct,
      context,
      story: {
        description,
        personality,
        persona: persona.position === PersonaPosition.IN_PROMPT ? personaText : '',
        scenario,
        system,
        wiBefore: worldInfo.before,
        wiAfter: worldInfo.after,
      },
      postHistory,
      extensionPrompts: ext,
      messages: core.map((m) => ({
        name: m.name,
        mes: m.content,
        isUser: m.role === 'user',
        isNarrator: m.role === 'system',
        forceAvatar: m.forceAvatar,
      })),
      examples: blocks,
      promptBias,
      forceName2,
      quietPrompt,
      quietToLoud: options.quietToLoud,
      quietName: options.quietName,
      chatLength: options.messages.length,
      lastIsUser: options.messages.at(-1)?.role === 'user',
      pinExamples: options.pinExamples ?? false,
      stripExamples: formatting.stripExamples,
      collapseNewlines: formatting.collapseNewlines,
      tokenPadding: formatting.tokenPadding,
      maxPromptTokens: maxPrompt,
      countTokens: countText,
      substitute: instructContext.substitute,
    });

    // Stop strings (SillyTavern `getStoppingStrings`)
    const stops: string[] = [];
    if (context.names_as_stop_strings) {
      const charString = `\n${card.name}:`;
      const userString = `\n${persona.name}:`;
      stops.push(isImpersonate ? charString : userString, userString);
      if (isContinue && options.messages.at(-1)?.role === 'user') stops.push(charString);
    }
    stops.push(...instructStoppingSequences(instructContext, isInstruct), ...customStops);
    if (context.single_line) stops.unshift('\n');
    const stoppingStrings = stops.filter((x) => x).filter((x, i, all) => all.indexOf(x) === i);

    // Token ids for banned tokens and logit bias, looked up while the body is built.
    const idTokenizer = text.idTokenizer;
    const ids = new Map<string, number[]>();
    if (idTokenizer?.encode) {
      for (const value of textgenTokenizationNeeds(text.settings, (v) => substitute(v), env.bannedWords)) {
        try {
          ids.set(value, await idTokenizer.encode(value));
        } catch {
          // left out, like SillyTavern
        }
      }
    }
    const stream = Boolean(text.settings.streaming) && type !== 'quiet';
    const data = textgenGenerateData({
      settings: text.settings,
      prompt: prompt.prompt,
      maxTokens: maxResponse,
      maxContext,
      type,
      stoppingStrings,
      substitute: (value) => substitute(value),
      bannedInMacros: env.bannedWords,
      tokenize: (value) => ids.get(value),
      logprobs: text.logprobs,
      stream,
    });
    return {
      ...common,
      api: 'text',
      data,
      prompt,
      http: textgenRequest(data),
      stream,
      stoppingStrings,
    };
  }

  // Chat Completion
  const { preset } = options;
  const model = options.connection.model;
  const sourceId = options.connection.provider.id;
  const history: HistoryMessage[] = core.map((m) => {
    // Signatures and reasoning only go back to the API and model that made them.
    const sameModel = m.extra.api === sourceId && m.extra.model === model;
    const invocations = Array.isArray(m.extra.tool_invocations)
      ? (m.extra.tool_invocations as ToolInvocation[]).map((i) => {
          if (sameModel || !(i.signature || i.reasoning)) return i;
          const { signature: _s, reasoning: _r, ...rest } = i;
          return rest;
        })
      : undefined;
    return {
      name: m.name,
      role: m.role,
      content: m.content,
      forceAvatar: m.forceAvatar,
      signature:
        sameModel && typeof m.extra.reasoning_signature === 'string'
          ? m.extra.reasoning_signature
          : undefined,
      reasoning: sameModel ? String(m.extra.reasoning ?? '') : '',
      media: messageAttachments(m.extra, options.mediaDisplay),
      invocations,
    };
  });
  const canPerformTools =
    !options.dryRun && canCallTools(type, canUseTools) && (options.toolDepth ?? 0) < TOOL_RECURSE_LIMIT;
  const media: MediaInlining | undefined =
    options.attachments && preset.media_inlining
      ? {
          image: imageInliningSupported(sourceId, model, options.modelInfo),
          video: videoInliningSupported(sourceId, model, options.modelInfo),
          audio: audioInliningSupported(sourceId, model, options.modelInfo),
          quality: preset.inline_image_quality || 'auto',
          compress: compressImageSources.includes(sourceId),
          resolver: options.attachments,
        }
      : undefined;
  const cyclePrompt = isContinue ? (core.at(-1)?.content ?? '') : '';
  const isClaude = options.connection.provider.family === 'anthropic';

  const prompt = await buildChatCompletion({
    type,
    preset,
    isGroup: false,
    charDescription: description,
    charPersonality: personality,
    scenario,
    worldInfoBefore: worldInfo.before,
    worldInfoAfter: worldInfo.after,
    bias: promptBias,
    quietPrompt,
    cyclePrompt,
    systemPromptOverride: systemPrompt,
    jailbreakPromptOverride: jailbreak,
    extensionPrompts: ext,
    personaDescription: personaInPrompt,
    messages: toPromptMessages(history, {
      namesBehavior: preset.names_behavior,
      userName: persona.name,
      isGroup: false,
    }),
    messageExamples: examplesToMessages(blocks, {
      userName: persona.name,
      charName: card.name,
      groupNames: [],
      isGroup: false,
    }),
    pinExamples: options.pinExamples ?? false,
    substitute,
    countTokens: messageTokenCounter(options.tokenizer, counter),
    supportsAssistantPrefill: isClaude,
    media,
    tools: {
      canUse: canUseTools,
      offered: canPerformTools ? (options.tools ?? []) : undefined,
      includeSignature: reasoningSignatureSupported(sourceId, model),
      reasoningMode: toolReasoningMode(sourceId, preset),
    },
  });

  const names = { charName: card.name, userName: persona.name, groupNames: [] as string[] };
  const connection = options.connection;
  const provider = connection.provider;
  let messages = prompt.messages;
  // SillyTavern's server post-processes every source's messages; the OpenAI-style sources do it
  // in their request builder (some force their own type), the others here.
  const ownAdapter = provider.family === 'anthropic' || provider.family === 'gemini';
  if (ownAdapter && preset.custom_prompt_post_processing) {
    messages = postProcessPrompt(messages, preset.custom_prompt_post_processing, names);
  }
  const stoppingStrings = customStops.filter(Boolean);
  const tokenizer = options.tokenizer;
  const logitBias =
    options.logitBias?.length && tokenizer.id !== 'claude' && tokenizer.encode
      ? await chatLogitBias(options.logitBias, (value) => tokenizer.encode!(value))
      : undefined;
  const prefillSource = type === 'impersonate' ? preset.assistant_impersonation : preset.assistant_prefill;
  const custom = provider.id === 'custom' ? await customBody(connection.customBody, substitute) : {};
  const request: GenerationRequest = {
    provider,
    baseUrl: connection.baseUrl,
    model: connection.model,
    messages,
    stream: chatStreams(preset, type, provider.id, connection.model),
    type,
    settings: { ...preset, ...connection.settings },
    ...custom,
    params: {
      temperature: preset.temp_openai,
      top_p: preset.top_p_openai,
      top_k: preset.top_k_openai,
      min_p: preset.min_p_openai,
      top_a: preset.top_a_openai,
      frequency_penalty: preset.freq_pen_openai,
      presence_penalty: preset.pres_pen_openai,
      repetition_penalty: preset.repetition_penalty_openai,
      max_tokens: preset.openai_max_tokens,
      stop: stoppingStrings,
      seed: preset.seed,
      n: preset.n,
      reasoning_effort: preset.reasoning_effort,
      verbosity: preset.verbosity,
      include_reasoning: preset.show_thoughts,
      logit_bias: logitBias,
    },
    // No prefill for quiet generations, or when continuing by prefill.
    assistantPrefill:
      isClaude && type !== 'quiet' && !(isContinue && preset.continue_prefill) && prefillSource
        ? substitute(prefillSource)
        : '',
    useSystemPrompt: preset.use_sysprompt,
    names,
    tools: canPerformTools && options.tools?.length ? options.tools : undefined,
  };
  return {
    ...common,
    api: 'chat',
    request,
    http: adapterFor(provider).buildRequest(request),
    prompt,
    stream: request.stream,
    stoppingStrings,
  };
}

/**
 * The Custom source's extra body fields, removed keys and headers. Like SillyTavern, macros are
 * substituted in the YAML before it is parsed; invalid YAML is ignored.
 */
async function customBody(
  yamlTexts: ConnectionInfo['customBody'],
  substitute: (text: string) => string,
): Promise<Pick<GenerationRequest, 'extraBody' | 'excludeBody' | 'extraHeaders'>> {
  if (!yamlTexts?.include && !yamlTexts?.exclude && !yamlTexts?.headers) return {};
  const { parse } = await import('yaml');
  const read = (text?: string): unknown => {
    if (!text) return undefined;
    try {
      return parse(substitute(text));
    } catch {
      return undefined;
    }
  };
  const headers = includeFromYaml(read(yamlTexts.headers));
  return {
    extraBody: includeFromYaml(read(yamlTexts.include)),
    excludeBody: excludeFromYaml(read(yamlTexts.exclude)),
    extraHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
  };
}

/** Greeting message(s) for a new chat: first message plus alternate greetings as swipes. */
export function greetingSwipes(
  card: unknown,
  macros: MacroEngine,
  env: MacroEnv,
  /** Applied before macros, like SillyTavern's AI output regex on new greetings. */
  transform: (text: string) => string = (text) => text,
): string[] {
  const data = cardData(card);
  const greetings = [data.first_mes, ...data.alternate_greetings].filter((g) => g.trim());
  return greetings.map((g) => macros.evaluate(transform(g.trim()), env));
}

export { joinExtensionPrompts };
