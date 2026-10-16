import type { Character, Chat, JobInfo, Message, NewMessage, Persona } from '@bakatavern/api-client';
import { upstreamError } from '@bakatavern/api-client';
import {
  adapterFor,
  applyDelta,
  cleanUpMessage,
  consumeStream,
  createMacroEngine,
  defaultFormattingSettings,
  extractReasoning,
  getProvider,
  getTextgenType,
  normalizeChatCompletionPreset,
  normalizeContextTemplate,
  normalizeInstructTemplate,
  normalizeSystemPrompt,
  normalizeTextgenSettings,
  itemizePrompt,
  modelsRequest,
  parseModels,
  prepareGeneration,
  RegexPlacement,
  textgenAdapter,
  type ChatCompletionPreset,
  type FormattingSettings,
  type GenerationOutput,
  type GenerationType,
  type PersonaInfo,
  type ModelInfo,
  type ModelListEntry,
  type PreparedGeneration,
  type PrepareOptions,
  type PromptItemization,
  type Tokenizer,
  type ToolDefinition,
  type ProviderAdapter,
  type ProviderDefinition,
  type RegexScript,
  type StoredMessage,
  type TextgenSettings,
  type TextgenTypeDefinition,
} from '@bakatavern/core';
import type { PresetInfo } from '@bakatavern/api-client';

import { api } from '../api.ts';
import { library } from '../state/library.svelte.ts';
import {
  chatDefaults,
  connectionDefaults,
  formattingDefaults,
  logitBiasDefaults,
  noteDefaults,
  textConnectionDefaults,
  uiDefaults,
  worldInfoDefaults,
  type ConnectionPrefs,
  type TextConnectionPrefs,
} from '../state/prefs.ts';
import { settings } from '../state/settings.svelte.ts';
import { loadBooks } from './books.ts';
import { browserAttachments } from './attachments.ts';
import { idTokenizerFor, tokenizerFor } from './tokenizers.ts';

export const macros = createMacroEngine();

/** Where a generated reply goes. */
export type Target =
  | { kind: 'new' }
  | { kind: 'swipe'; messageId: string }
  | { kind: 'continue'; messageId: string }
  | { kind: 'impersonate' };

/** Stored with each job so a reply can be finished even after a reload. */
export interface JobMeta {
  type: GenerationType;
  target: Target;
  /** Text Completion jobs name their backend type in `providerId`. */
  api?: 'chat' | 'text';
  providerId: string;
  model: string;
  stream: boolean;
  charName: string;
  personaName: string;
  startedAt: string;
  /** Text of the message being continued. */
  continuedText?: string;
  continuePostfix?: string;
  /** Strings that end the reply (they are cut off if the backend sends them). */
  stoppingStrings?: string[];
}

export interface ActiveChatConnection {
  api: 'chat';
  provider: ProviderDefinition;
  model: string;
  baseUrl?: string;
  secretId?: string;
  /** Source options with SillyTavern's keys, including the regional endpoint (`zai_endpoint`). */
  settings: Record<string, unknown>;
  customBody?: { include: string; exclude: string; headers: string };
}

export interface ActiveTextConnection {
  api: 'text';
  type: TextgenTypeDefinition;
  model: string;
  serverUrl: string;
  secretId?: string;
  prefs: TextConnectionPrefs;
}

export type ActiveConnection = ActiveChatConnection | ActiveTextConnection;

/** The Text Completion part of the connection settings, with defaults. */
export function textPrefs(prefs: ConnectionPrefs): TextConnectionPrefs {
  return { ...textConnectionDefaults, ...prefs.text };
}

export function activeConnection(): ActiveConnection | null {
  const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
  if (prefs.api === 'text') {
    const text = textPrefs(prefs);
    const type = getTextgenType(text.type);
    if (!type) return null;
    const serverUrl = type.server ?? text.serverUrls[type.id] ?? '';
    const model = text.models[type.id] || type.defaultModel || '';
    if (!serverUrl || (type.modelRequired && !model)) return null;
    return {
      api: 'text',
      type,
      model,
      serverUrl,
      secretId: text.secretIds[type.id] || undefined,
      prefs: text,
    };
  }
  const provider = getProvider(prefs.providerId);
  if (!provider) return null;
  const endpoint = prefs.endpoints[provider.id];
  const baseUrl =
    prefs.baseUrls[provider.id] ||
    (endpoint ? provider.endpoints?.[endpoint] : undefined) ||
    provider.baseUrl;
  const model = prefs.models[provider.id] || provider.defaultModel || '';
  if (!baseUrl || !model) return null;
  return {
    api: 'chat',
    provider,
    model,
    baseUrl,
    secretId: prefs.secretIds[provider.id] || undefined,
    settings: {
      ...prefs.sourceSettings?.[provider.id],
      // SillyTavern names the endpoint choice `<source>_endpoint` (zai, siliconflow, minimax, ...).
      ...(provider.endpoints
        ? { [`${provider.id}_endpoint`]: endpoint ?? Object.keys(provider.endpoints)[0] }
        : {}),
    },
    customBody:
      provider.id === 'custom' ? { ...connectionDefaults.customBody, ...prefs.customBody } : undefined,
  };
}

/** Preset data by id, refetched when the preset's revision changes. */
const presetData = new Map<string, { rev: number; data: Record<string, unknown> }>();

async function loadPresetData(info: PresetInfo | undefined): Promise<Record<string, unknown> | undefined> {
  if (!info) return undefined;
  const cached = presetData.get(info.id);
  if (cached?.rev === info.rev) return cached.data;
  const preset = await api.getPreset(info.id);
  presetData.set(info.id, { rev: preset.rev, data: preset.data });
  return preset.data;
}

/** The selected preset of a kind, or the one named `fallback`, or the first. */
export function pickPreset(
  kind: string,
  id: string | null | undefined,
  fallback?: string,
): PresetInfo | undefined {
  const list = library.presets.filter((p) => p.kind === kind);
  return (
    list.find((p) => p.id === id) ?? (fallback ? list.find((p) => p.name === fallback) : undefined) ?? list[0]
  );
}

/** Advanced Formatting in effect, kept for cleaning up replies after the generation. */
let currentFormatting: FormattingSettings = defaultFormattingSettings;

export async function activeFormatting(): Promise<FormattingSettings> {
  const prefs = { ...formattingDefaults, ...settings.get('formatting', formattingDefaults) };
  const [instruct, context, sysprompt] = await Promise.all([
    loadPresetData(pickPreset('instruct', prefs.instructId, 'Alpaca')),
    loadPresetData(pickPreset('context', prefs.contextId, 'Default')),
    loadPresetData(pickPreset('sysprompt', prefs.syspromptId, 'Neutral - Chat')),
  ]);
  currentFormatting = {
    instructEnabled: prefs.instructEnabled && Boolean(instruct),
    instruct: instruct ? normalizeInstructTemplate(instruct) : defaultFormattingSettings.instruct,
    context: context ? normalizeContextTemplate(context) : defaultFormattingSettings.context,
    syspromptEnabled: prefs.syspromptEnabled && Boolean(sysprompt),
    sysprompt: sysprompt ? normalizeSystemPrompt(sysprompt) : defaultFormattingSettings.sysprompt,
    preferCharacterPrompt: prefs.preferCharacterPrompt,
    preferCharacterJailbreak: prefs.preferCharacterJailbreak,
    collapseNewlines: prefs.collapseNewlines,
    tokenPadding: prefs.tokenPadding,
    stripExamples: prefs.stripExamples,
  };
  return currentFormatting;
}

/** SillyTavern Text Completion settings: the preset's samplers with the connection's type and model. */
export async function activeTextSettings(connection: ActiveTextConnection): Promise<TextgenSettings> {
  const preset = await loadPresetData(pickPreset('textgen', connection.prefs.presetId));
  const modelSetting = connection.type.modelSetting;
  return normalizeTextgenSettings({
    ...preset,
    ...connection.prefs.settings,
    type: connection.type.id,
    server_urls: { ...connection.prefs.serverUrls, [connection.type.id]: connection.serverUrl },
    streaming: connection.prefs.streaming,
    ...(modelSetting ? { [modelSetting]: connection.model } : {}),
  });
}

export async function activePreset(): Promise<ChatCompletionPreset> {
  const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
  const data = await loadPresetData(pickPreset('openai', prefs.presetId));
  return normalizeChatCompletionPreset(data ?? {});
}

export function invalidatePreset() {
  presetData.clear();
}

/**
 * The key World Info character filters use: SillyTavern's avatar file name without extension,
 * or the name for characters created here.
 */
export function characterKey(character: { sourceFile: string | null; name: string }): string {
  return character.sourceFile ? character.sourceFile.replace(/\.[^.]+$/, '') : character.name;
}

export function personaInfo(persona: Persona | undefined): PersonaInfo {
  return {
    name: persona?.name ?? 'User',
    description: persona?.description ?? '',
    position: persona?.position ?? 0,
    depth: persona?.depth ?? 2,
    role: persona?.role ?? 0,
  };
}

export function storedMessages(messages: readonly Message[]): StoredMessage[] {
  return messages.map((m) => ({
    name: m.name,
    role: m.role as StoredMessage['role'],
    hidden: m.hidden,
    content: m.swipes[m.swipeId]?.content ?? '',
    swipeId: m.swipeId,
    swipeCount: m.swipes.length,
    extra: m.extra,
    forceAvatar: Boolean(m.data.force_avatar),
  }));
}

export interface GenerationInput {
  type: GenerationType;
  character: Character;
  persona: Persona | undefined;
  chat: Chat;
  /** Chat metadata to use (mutated with World Info timers and variables). */
  metadata: Record<string, unknown>;
  messages: readonly Message[];
  /** Regex scripts in effect (see `regex.scriptsFor`). */
  regexScripts: readonly RegexScript[];
  quietPrompt?: string;
  dryRun?: boolean;
  /** Function tools to offer (Chat Completion), and the tool rounds so far. */
  tools?: ToolDefinition[];
  toolDepth?: number;
}

export async function prepare(
  input: GenerationInput,
  connection: ActiveConnection,
): Promise<PreparedGeneration> {
  const card = input.character.card as { data?: { extensions?: { world?: string } } };
  const wiPrefs = settings.get('worldinfo', worldInfoDefaults);
  const notePrefs = settings.get('note', noteDefaults);
  const chatPrefs = settings.get('chat', chatDefaults);
  const formattingPrefs = { ...formattingDefaults, ...settings.get('formatting', formattingDefaults) };
  const tokenizer = tokenizerFor(connection);
  const [global, character, chatBooks, personaBooks, formatting] = await Promise.all([
    loadBooks(wiPrefs.globalBooks),
    loadBooks([card.data?.extensions?.world, ...(wiPrefs.characterExtraBooks[input.character.id] ?? [])]),
    loadBooks([input.metadata.world_info as string | undefined]),
    loadBooks([input.persona?.lorebook]),
    activeFormatting(),
  ]);
  const note = notePrefs.characterNotes[input.character.id];
  const common = {
    type: input.type,
    card: input.character.card,
    characterKey: characterKey(input.character),
    characterTags: input.character.tags,
    persona: personaInfo(input.persona),
    chatId: input.chat.id,
    chatMetadata: input.metadata,
    messages: storedMessages(input.messages),
    worldInfo: {
      settings: { ...worldInfoDefaults.settings, ...wiPrefs.settings },
      global,
      character,
      chat: chatBooks[0] ?? null,
      persona: personaBooks[0] ?? null,
    },
    authorsNote: { allowWIScan: notePrefs.allowWIScan, characterNote: note },
    globalVariables: settings.get('variables', {}) as Record<string, unknown>,
    tokenizer,
    macros,
    formatting,
    quietPrompt: input.quietPrompt,
    promptBias: chatPrefs.promptBias,
    stoppingStrings: chatPrefs.stoppingStrings,
    regexScripts: input.regexScripts,
    reasoning: {
      addToPrompts: chatPrefs.reasoningAddToPrompts,
      maxAdditions: chatPrefs.reasoningMaxAdditions,
      prefix: chatPrefs.reasoningPrefix,
      suffix: chatPrefs.reasoningSuffix,
      separator: chatPrefs.reasoningSeparator,
    },
    pinExamples: formattingPrefs.pinExamples,
    dryRun: input.dryRun,
  };
  const attachments = {
    attachments: browserAttachments,
    mediaDisplay: settings.get('ui', uiDefaults).mediaDisplay ?? 'list',
  };
  let options: PrepareOptions;
  if (connection.api === 'text') {
    options = {
      ...common,
      ...attachments,
      api: 'text',
      text: {
        settings: await activeTextSettings(connection),
        maxContext: connection.prefs.maxContext,
        maxResponse: connection.prefs.maxResponse,
        secretId: connection.secretId,
        idTokenizer: idTokenizerFor(connection),
      },
    };
  } else {
    const preset = await activePreset();
    const biasLists = settings.get('logitbias', logitBiasDefaults).lists;
    const logitBias = preset.bias_preset_selected
      ? biasLists[String(preset.bias_preset_selected)]
      : undefined;
    // What the model accepts inline comes from the provider's model list for some sources.
    const hasMedia = input.messages.some((m) => {
      const extra = m.extra as { media?: unknown; image?: unknown; video?: unknown };
      return Array.isArray(extra.media) ? extra.media.length > 0 : Boolean(extra.image || extra.video);
    });
    // Model lists also tell whether some sources' models can call tools.
    const modelInfo =
      hasMedia || (preset.function_calling && input.tools?.length) ? await modelEntry(connection) : undefined;
    options = {
      ...common,
      ...attachments,
      preset,
      connection,
      logitBias,
      modelInfo,
      tools: input.tools,
      toolDepth: input.toolDepth,
    };
  }
  const prepared = await prepareGeneration(options);
  preparedWith.set(prepared, { options, tokenizer });
  return prepared;
}

/** Model list entries by provider and address, fetched once per session when needed. */
const modelLists = new Map<string, Promise<ModelInfo[]>>();

/** The connection's model as its provider lists it (`undefined` when it cannot be listed). */
export async function modelEntry(connection: ActiveChatConnection): Promise<ModelListEntry | undefined> {
  const spec = modelsRequest(connection.provider, connection.baseUrl);
  if (!spec) return undefined;
  const key = `${connection.provider.id}\u0000${spec.url}`;
  let list = modelLists.get(key);
  if (!list) {
    list = api
      .proxyJson({ ...spec, secretId: connection.secretId })
      .then((body) => parseModels(connection.provider, body))
      .catch(() => {
        modelLists.delete(key);
        return [];
      });
    modelLists.set(key, list);
  }
  return (await list).find((m) => m.id === connection.model)?.entry;
}

/** Remembers a model list loaded elsewhere (the connection panel). */
export function rememberModels(connection: ActiveChatConnection, models: ModelInfo[]) {
  const spec = modelsRequest(connection.provider, connection.baseUrl);
  if (spec) modelLists.set(`${connection.provider.id}\u0000${spec.url}`, Promise.resolve(models));
}

/** What each prepared generation was built from, for its itemization. */
const preparedWith = new WeakMap<PreparedGeneration, { options: PrepareOptions; tokenizer: Tokenizer }>();

/** The token breakdown of a prepared generation (for the prompt viewer). */
export function itemizeGeneration(prepared: PreparedGeneration): Promise<PromptItemization> | null {
  const source = preparedWith.get(prepared);
  return source ? itemizePrompt(prepared, source.options, source.tokenizer) : null;
}

/** Parses responses of the job's API and provider (`undefined` for unknown ones). */
export function responseAdapter(
  meta: Pick<JobMeta, 'api' | 'providerId'>,
): Pick<ProviderAdapter, 'createDecoder' | 'parseResponse'> | undefined {
  if (meta.api === 'text')
    return getTextgenType(meta.providerId) ? textgenAdapter(meta.providerId) : undefined;
  const provider = getProvider(meta.providerId);
  return provider ? adapterFor(provider) : undefined;
}

/** Reads a job response (streamed or not) into a generation output. */
export async function readResponse(
  response: Response,
  adapter: Pick<ProviderAdapter, 'createDecoder' | 'parseResponse'>,
  stream: boolean,
  onUpdate: (output: GenerationOutput, bytes: number) => void,
  signal?: AbortSignal,
  initial?: GenerationOutput,
): Promise<GenerationOutput> {
  if (!response.ok) {
    throw upstreamError(response.status, await response.text());
  }
  if (!stream) {
    const delta = adapter.parseResponse(await response.json());
    const output = applyDelta(initial ?? { text: '', reasoning: '' }, delta);
    onUpdate(output, 0);
    return output;
  }
  const output = await consumeStream(response.body!, adapter.createDecoder(), onUpdate, signal);
  if (initial) {
    output.text = initial.text + output.text;
    output.reasoning = initial.reasoning + output.reasoning;
  }
  return output;
}

/**
 * Turns raw model output into the text and reasoning that get stored. `regex` runs the chat's
 * regex scripts for a placement.
 */
export function finalizeOutput(
  output: GenerationOutput,
  meta: JobMeta,
  stoppingStrings: readonly string[],
  regex: (text: string, placement: number) => string = (text) => text,
) {
  const chatPrefs = settings.get('chat', chatDefaults);
  let text = output.text;
  let reasoning = output.reasoning;
  if (chatPrefs.reasoningAutoParse) {
    const parsed = extractReasoning(text, {
      prefix: chatPrefs.reasoningPrefix,
      suffix: chatPrefs.reasoningSuffix,
    });
    if (parsed) {
      reasoning = [reasoning, parsed.reasoning].filter(Boolean).join('\n');
      text = parsed.content;
    }
  }
  const formatting = currentFormatting;
  const impersonate = meta.type === 'impersonate';
  text = cleanUpMessage(text, {
    isImpersonate: impersonate,
    isContinue: meta.type === 'continue',
    stoppingStrings,
    applyRegex: (message) =>
      regex(message, impersonate ? RegexPlacement.USER_INPUT : RegexPlacement.AI_OUTPUT),
    wrongName: impersonate ? meta.charName : meta.personaName,
    charName: meta.charName,
    ownName: impersonate ? meta.personaName : meta.charName,
    collapseNewlines: formatting.collapseNewlines,
    instruct: meta.api === 'text' && formatting.instructEnabled ? formatting.instruct : undefined,
    trimSentences: formatting.context.trim_sentences,
    promptBias:
      meta.type === 'continue' || impersonate
        ? undefined
        : macros.evaluate(chatPrefs.promptBias, { user: meta.personaName, char: meta.charName }),
  });
  // A continuation keeps its leading whitespace so it joins the original text naturally.
  const trimSpaces = settings.get('formatting', formattingDefaults).trimSpaces !== false;
  if (trimSpaces) text = meta.type === 'continue' ? text.trimEnd() : text.trim();
  return { text, reasoning: regex(reasoning, RegexPlacement.REASONING).trim() };
}

/** Swipe metadata in SillyTavern's shape. */
export function swipeInfo(meta: JobMeta, reasoning: string, finishedAt = new Date()) {
  // SillyTavern names Text Completion replies by backend, oobabooga's as `textgenerationwebui`.
  const api = meta.api === 'text' && meta.providerId === 'ooba' ? 'textgenerationwebui' : meta.providerId;
  const extra: Record<string, unknown> = { api, model: meta.model };
  if (reasoning) {
    extra.reasoning = reasoning;
    extra.reasoning_duration = finishedAt.getTime() - Date.parse(meta.startedAt);
  }
  return {
    send_date: finishedAt.toISOString(),
    gen_started: meta.startedAt,
    gen_finished: finishedAt.toISOString(),
    extra,
  };
}

export function newAssistantMessage(meta: JobMeta, text: string, reasoning: string): NewMessage {
  const info = swipeInfo(meta, reasoning);
  return {
    role: 'assistant',
    name: meta.charName,
    swipes: [{ content: text, info }],
    sendDate: info.send_date,
    extra: info.extra,
    data: { gen_started: info.gen_started, gen_finished: info.gen_finished },
  };
}

export function isFinished(job: JobInfo) {
  return job.status !== 'running';
}
