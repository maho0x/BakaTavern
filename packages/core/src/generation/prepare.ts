/**
 * Generation orchestration for Chat Completion APIs — the parts of SillyTavern's `Generate()`
 * that decide what goes into the prompt: card fields, Author's Note, character and persona
 * injections, World Info, example dialogues, then `buildChatCompletion` and the provider request.
 */

import { cardData, type CardData } from '../model/card.ts';
import { objectVariables, type MacroEngine, type MacroEnv } from '../macros/index.ts';
import {
  buildChatCompletion,
  examplesToMessages,
  ExtensionPromptPosition,
  ExtensionPromptRole,
  InjectKeys,
  joinExtensionPrompts,
  parseMesExamples,
  postProcessPrompt,
  toPromptMessages,
  type ChatCompletionPreset,
  type ChatCompletionResult,
  type ExtensionPrompt,
  type GenerationType,
  type HistoryMessage,
} from '../prompt/index.ts';
import {
  adapterFor,
  type GenerationRequest,
  type HttpRequestSpec,
  type ProviderDefinition,
} from '../providers/index.ts';
import { messageTokenCounter, TokenCache, type Tokenizer } from '../tokenizers/index.ts';
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
}

export interface PrepareOptions {
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
  preset: ChatCompletionPreset;
  connection: ConnectionInfo;
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
  quietPrompt?: string;
  /** Extra injections from plugins, keyed like SillyTavern extension prompts. */
  extraInjections?: Record<string, ExtensionPrompt>;
  /** "Start reply with". */
  promptBias?: string;
  stoppingStrings?: readonly string[];
  /** Include the previous reasoning blocks in the prompt (SillyTavern `reasoning.add_to_prompts`). */
  pinExamples?: boolean;
  now?: () => Date;
  random?: () => number;
  dryRun?: boolean;
}

export interface PreparedGeneration {
  request: GenerationRequest;
  http: HttpRequestSpec;
  prompt: ChatCompletionResult;
  worldInfo: WorldInfoScanResult;
  extensionPrompts: Record<string, ExtensionPrompt>;
  env: MacroEnv;
  /** Strings that end the reply (custom stop strings plus the user name line). */
  stoppingStrings: string[];
}

function roleId(role: string | number | undefined): number {
  if (typeof role === 'number') return role;
  if (role === 'user') return ExtensionPromptRole.USER;
  if (role === 'assistant') return ExtensionPromptRole.ASSISTANT;
  return ExtensionPromptRole.SYSTEM;
}

export function macroEnvFor(options: PrepareOptions, card: CardData): MacroEnv {
  const local = (options.chatMetadata.variables ??= {}) as Record<string, unknown>;
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
    model: options.connection.model,
    lastGenerationType: options.type,
    maxContextTokens: options.preset.openai_max_context,
    maxResponseTokens: options.preset.openai_max_tokens,
    maxPromptTokens: options.preset.openai_max_context - options.preset.openai_max_tokens,
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
  };
}

export async function prepareGeneration(options: PrepareOptions): Promise<PreparedGeneration> {
  const card = cardData(options.card);
  const { preset, macros, type } = options;
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
  const base = (text: string) => (text ? macros.evaluate(text.trim(), cardEnv).replace(/\r/g, '') : '');

  const description = base(card.description);
  const personality = base(card.personality);
  const scenario = base(String(options.chatMetadata.scenario || card.scenario));
  const personaText = base(options.persona.description);
  const examplesText = base(String(options.chatMetadata.mes_example || card.mes_example));
  const systemPrompt = base(String(options.chatMetadata.system_prompt || card.system_prompt));
  const jailbreak = base(card.post_history_instructions);
  const depthPrompt = base(card.extensions.depth_prompt?.prompt ?? '');
  Object.assign(env, {
    description,
    personality,
    scenario,
    persona: personaText,
    mesExamplesRaw: examplesText,
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

  // Messages that enter the prompt
  let core = options.messages.filter((m) => !m.hidden);
  if (type === 'swipe') core = core.slice(0, -1);

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
  if (options.quietPrompt)
    set(InjectKeys.QUIET_PROMPT, options.quietPrompt, ExtensionPromptPosition.IN_PROMPT, 0, true);
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
  const maxPrompt = preset.openai_max_context - preset.openai_max_tokens;
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
    countTokens: (text) => counter.count(options.tokenizer, text),
    random: options.random,
  });
  if (options.quietPrompt) delete ext[InjectKeys.QUIET_PROMPT];

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

  // Example dialogues (+ World Info example entries)
  const blocks = parseMesExamples(examplesText);
  for (const example of worldInfo.examples) {
    if (!example.content) continue;
    const parsed = parseMesExamples(base(example.content));
    if (example.position === 'before') blocks.unshift(...parsed);
    else blocks.push(...parsed);
  }
  env.mesExamples = blocks.join('');

  // History in prompt form
  const history: HistoryMessage[] = core.map((m) => ({
    name: m.name,
    role: m.role,
    content: m.content,
    forceAvatar: m.forceAvatar,
    signature: typeof m.extra.reasoning_signature === 'string' ? m.extra.reasoning_signature : undefined,
  }));
  const isContinue = type === 'continue';
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
    bias: options.promptBias ? substitute(options.promptBias) : '',
    quietPrompt: options.quietPrompt ? substitute(options.quietPrompt) : '',
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
  });

  const names = { charName: card.name, userName: persona.name, groupNames: [] as string[] };
  const provider = options.connection.provider;
  let messages = prompt.messages;
  if (provider.family === 'openai-chat' && preset.custom_prompt_post_processing) {
    messages = postProcessPrompt(messages, preset.custom_prompt_post_processing, names);
  }
  const stoppingStrings = [...(options.stoppingStrings ?? []).map((s) => substitute(s))].filter(Boolean);
  const prefillSource = type === 'impersonate' ? preset.assistant_impersonation : preset.assistant_prefill;
  const request: GenerationRequest = {
    provider,
    baseUrl: options.connection.baseUrl,
    model: options.connection.model,
    messages,
    stream: preset.stream_openai,
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
    },
    assistantPrefill: isClaude && !isContinue && prefillSource ? substitute(prefillSource) : '',
    useSystemPrompt: preset.use_sysprompt,
    names,
  };
  return {
    request,
    http: adapterFor(provider).buildRequest(request),
    prompt,
    worldInfo,
    extensionPrompts: ext,
    env,
    stoppingStrings,
  };
}

/** Greeting message(s) for a new chat: first message plus alternate greetings as swipes. */
export function greetingSwipes(card: unknown, macros: MacroEngine, env: MacroEnv): string[] {
  const data = cardData(card);
  const greetings = [data.first_mes, ...data.alternate_greetings].filter((g) => g.trim());
  return greetings.map((g) => macros.evaluate(g.trim(), env));
}

export { joinExtensionPrompts };
