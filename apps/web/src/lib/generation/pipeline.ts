import type { Character, Chat, JobInfo, Message, NewMessage, Persona } from '@bakatavern/api-client';
import { upstreamError } from '@bakatavern/api-client';
import {
  adapterFor,
  applyDelta,
  cleanUpMessage,
  consumeStream,
  createMacroEngine,
  extractReasoning,
  getProvider,
  loadTokenizer,
  normalizeChatCompletionPreset,
  prepareGeneration,
  tokenizerFor,
  type ChatCompletionPreset,
  type GenerationOutput,
  type GenerationType,
  type PersonaInfo,
  type PreparedGeneration,
  type ProviderDefinition,
  type StoredMessage,
} from '@bakatavern/core';

import { api } from '../api.ts';
import { library } from '../state/library.svelte.ts';
import {
  chatDefaults,
  connectionDefaults,
  noteDefaults,
  worldInfoDefaults,
  type ConnectionPrefs,
} from '../state/prefs.ts';
import { settings } from '../state/settings.svelte.ts';
import { loadBooks } from './books.ts';

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
  providerId: string;
  model: string;
  stream: boolean;
  charName: string;
  personaName: string;
  startedAt: string;
  /** Text of the message being continued. */
  continuedText?: string;
  continuePostfix?: string;
}

export interface ActiveConnection {
  provider: ProviderDefinition;
  model: string;
  baseUrl?: string;
  secretId?: string;
}

export function activeConnection(): ActiveConnection | null {
  const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
  const provider = getProvider(prefs.providerId);
  if (!provider) return null;
  const endpoint = prefs.endpoints[provider.id];
  const baseUrl =
    prefs.baseUrls[provider.id] ||
    (endpoint ? provider.endpoints?.[endpoint] : undefined) ||
    provider.baseUrl;
  const model = prefs.models[provider.id] || provider.defaultModel || '';
  if (!baseUrl || !model) return null;
  return { provider, model, baseUrl, secretId: prefs.secretIds[provider.id] || undefined };
}

let presetCache: { id: string; rev: number; preset: ChatCompletionPreset } | null = null;

export async function activePreset(): Promise<ChatCompletionPreset> {
  const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
  const info =
    library.presets.find((p) => p.id === prefs.presetId && p.kind === 'openai') ??
    library.presets.find((p) => p.kind === 'openai');
  if (!info) return normalizeChatCompletionPreset({});
  if (presetCache?.id === info.id && presetCache.rev === info.rev) return presetCache.preset;
  const preset = await api.getPreset(info.id);
  presetCache = { id: info.id, rev: preset.rev, preset: normalizeChatCompletionPreset(preset.data) };
  return presetCache.preset;
}

export function invalidatePreset() {
  presetCache = null;
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
  quietPrompt?: string;
  dryRun?: boolean;
}

export async function prepare(
  input: GenerationInput,
  connection: ActiveConnection,
): Promise<PreparedGeneration> {
  const card = input.character.card as { data?: { extensions?: { world?: string } } };
  const wiPrefs = settings.get('worldinfo', worldInfoDefaults);
  const notePrefs = settings.get('note', noteDefaults);
  const chatPrefs = settings.get('chat', chatDefaults);
  const [global, character, chatBooks, personaBooks, preset, tokenizer] = await Promise.all([
    loadBooks(wiPrefs.globalBooks),
    loadBooks([card.data?.extensions?.world, ...(wiPrefs.characterExtraBooks[input.character.id] ?? [])]),
    loadBooks([input.metadata.world_info as string | undefined]),
    loadBooks([input.persona?.lorebook]),
    activePreset(),
    loadTokenizer(tokenizerFor(connection.provider.id, connection.model)),
  ]);
  const note = notePrefs.characterNotes[input.character.id];
  return prepareGeneration({
    type: input.type,
    card: input.character.card,
    characterKey: (input.character.sourceFile ?? input.character.name).replace(/\.[^.]+$/, ''),
    characterTags: input.character.tags,
    persona: personaInfo(input.persona),
    chatId: input.chat.id,
    chatMetadata: input.metadata,
    messages: storedMessages(input.messages),
    preset,
    connection,
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
    quietPrompt: input.quietPrompt,
    promptBias: chatPrefs.promptBias,
    stoppingStrings: chatPrefs.stoppingStrings,
    dryRun: input.dryRun,
  });
}

/** Reads a job response (streamed or not) into a generation output. */
export async function readResponse(
  response: Response,
  provider: ProviderDefinition,
  stream: boolean,
  onUpdate: (output: GenerationOutput, bytes: number) => void,
  signal?: AbortSignal,
  initial?: GenerationOutput,
): Promise<GenerationOutput> {
  if (!response.ok) {
    throw upstreamError(response.status, await response.text());
  }
  const adapter = adapterFor(provider);
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

/** Turns raw model output into the text and reasoning that get stored. */
export function finalizeOutput(output: GenerationOutput, meta: JobMeta, stoppingStrings: readonly string[]) {
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
  text = cleanUpMessage(text, {
    isImpersonate: meta.type === 'impersonate',
    isContinue: meta.type === 'continue',
    stoppingStrings,
    wrongName: meta.type === 'impersonate' ? meta.charName : meta.personaName,
    promptBias:
      meta.type === 'continue' || meta.type === 'impersonate'
        ? undefined
        : macros.evaluate(chatPrefs.promptBias, { user: meta.personaName, char: meta.charName }),
  });
  // A continuation keeps its leading whitespace so it joins the original text naturally.
  text = meta.type === 'continue' ? text.trimEnd() : text.trim();
  return { text, reasoning: reasoning.trim() };
}

/** Swipe metadata in SillyTavern's shape. */
export function swipeInfo(meta: JobMeta, reasoning: string, finishedAt = new Date()) {
  const extra: Record<string, unknown> = { api: meta.providerId, model: meta.model };
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
