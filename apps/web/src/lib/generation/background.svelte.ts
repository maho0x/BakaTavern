/**
 * Generations that don't add a reply to the chat (SillyTavern `generateQuietPrompt` and
 * `generateRaw`): `/gen`, `/genraw`, Quick Replies and plugins ask for text this way.
 */

import type { Character, Message } from '@bakatavern/api-client';
import {
  extractReasoning,
  trimToEndSentence,
  type GenerationOutput,
  type RawPromptOptions,
} from '@bakatavern/core';

import { api } from '../api.ts';
import { t } from '../i18n/index.svelte.ts';
import { chat } from '../state/chat.svelte.ts';
import { chatDefaults } from '../state/prefs.ts';
import { regex } from '../state/regex.svelte.ts';
import { settings } from '../state/settings.svelte.ts';
import {
  activeConnection,
  activeFormatting,
  finalizeOutput,
  prepare,
  prepareRaw,
  readResponse,
  responseAdapter,
  unsentUserMessage,
  type GenerationInput,
  type JobMeta,
} from './pipeline.ts';

export interface QuietRequest {
  /** The instruction. */
  prompt: string;
  /** Answer in character instead of as the system. */
  toLoud?: boolean;
  /** Who answers in Text Completion's prompt line. */
  name?: string;
  responseLength?: number;
  /** In a group, this member answers. */
  characterId?: string;
  /** Cut the reply after its last complete sentence. */
  trimToSentence?: boolean;
  /** Leave a reasoning block out of the reply (default). */
  removeReasoning?: boolean;
  stop?: string[];
  signal?: AbortSignal;
}

export interface RawRequest extends RawPromptOptions {
  responseLength?: number;
  /** Remove `Name:` the reply may start with (default). */
  trimNames?: boolean;
  stop?: string[];
  signal?: AbortSignal;
}

/** The chat and the character the generation is about (in a group: the member). */
function context(characterId?: string): Omit<GenerationInput, 'type'> {
  const current = chat.chat;
  if (!current) throw new Error(t('script.noChat'));
  let character: Character | null = chat.character;
  if (chat.group) {
    const id = characterId ?? chat.groupSpeaker('quiet');
    character = chat.members.find((m) => m.id === id) ?? chat.members[0] ?? null;
  }
  if (!character) throw new Error(t('script.noCharacter'));
  return {
    character: $state.snapshot(character) as Character,
    persona: chat.persona,
    userName: chat.userName,
    chat: current,
    metadata: $state.snapshot(current.metadata) as Record<string, unknown>,
    globalVariables: $state.snapshot(settings.get('variables', {})) as Record<string, unknown>,
    messages: $state.snapshot(chat.messages) as Message[],
    regexScripts: $state.snapshot(regex.scriptsFor(character)),
    group: chat.group ? chat.groupContext(character) : undefined,
  };
}

/** Saves the variables the prompt's macros changed. */
function keepVariables(input: Omit<GenerationInput, 'type'>) {
  return chat.keepGenerationVariables(
    input.globalVariables ?? {},
    input.metadata.variables as Record<string, unknown> | undefined,
  );
}

/** Sends a prepared request and reads the whole reply. */
async function send(
  http: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  meta: JobMeta,
  stream: boolean,
  secretId: string | undefined,
  signal?: AbortSignal,
): Promise<GenerationOutput> {
  const response = await api.proxy({ ...(http as { url: string }), secretId }, signal);
  const adapter = responseAdapter(meta);
  if (!adapter) throw new Error(t('chat.noConnection'));
  const output = await readResponse(response, adapter, stream, () => {}, signal);
  if (output.error) throw new Error(output.error);
  return output;
}

function metaFor(
  connection: NonNullable<ReturnType<typeof activeConnection>>,
  input: Omit<GenerationInput, 'type'>,
  model: string,
  stream: boolean,
): JobMeta {
  return {
    type: 'quiet',
    target: { kind: 'new' },
    api: connection.api,
    providerId: connection.api === 'text' ? connection.type.id : connection.provider.id,
    model,
    stream,
    charName: input.character.name,
    personaName: input.persona?.name ?? 'User',
    startedAt: new Date().toISOString(),
    groupNames: input.group?.members.map((m) => m.name),
  };
}

/** Removes a reasoning block (SillyTavern `removeReasoningFromString`). */
function withoutReasoning(text: string): string {
  const prefs = settings.get('chat', chatDefaults);
  const parsed = extractReasoning(text, { prefix: prefs.reasoningPrefix, suffix: prefs.reasoningSuffix });
  return parsed ? parsed.content : text;
}

/** A background reply to an instruction, with the chat as context. */
export async function generateQuiet(request: QuietRequest): Promise<string> {
  const connection = activeConnection();
  if (!connection) throw new Error(t('chat.noConnection'));
  const input = context(request.characterId);
  await activeFormatting();
  const prepared = await prepare(
    {
      ...input,
      type: 'quiet',
      quiet: { prompt: request.prompt, toLoud: request.toLoud, name: request.name },
      responseLength: request.responseLength,
      extraStops: request.stop,
    },
    connection,
  );
  await keepVariables(input);
  const meta = metaFor(connection, input, prepared.model, prepared.stream);
  const output = await send(prepared.http, meta, prepared.stream, connection.secretId, request.signal);
  const scripts = input.regexScripts;
  let { text } = finalizeOutput(output, meta, prepared.stoppingStrings, (raw, placement) =>
    scripts.length ? chat.applyRegex(raw, placement) : raw,
  );
  if (request.trimToSentence) text = trimToEndSentence(text);
  if (request.removeReasoning !== false) text = withoutReasoning(text);
  return text;
}

/** A reply to a prompt given directly, without the chat. */
export async function generateRaw(request: RawRequest): Promise<string> {
  const connection = activeConnection();
  if (!connection) throw new Error(t('chat.noConnection'));
  const input = context();
  await activeFormatting();
  const prepared = await prepareRaw(
    { ...input, type: 'quiet', responseLength: request.responseLength, extraStops: request.stop },
    connection,
    request,
  );
  await keepVariables(input);
  const meta = metaFor(connection, input, prepared.model, prepared.stream);
  const output = await send(prepared.http, meta, prepared.stream, connection.secretId, request.signal);
  const trimNames = request.trimNames !== false;
  const { text } = finalizeOutput(
    output,
    meta,
    prepared.stoppingStrings,
    (raw, placement) => chat.applyRegex(raw, placement),
    {
      promptBias: false,
      trimNames,
      trimSentences: false,
    },
  );
  if (!text) throw new Error(t('script.noReply'));
  return text;
}

export interface InputRequest {
  /** What the user says; it is not added to the chat. */
  input: string;
  /** Only the latest messages of the chat (TavernHelper `max_chat_history`). */
  maxHistory?: number;
  responseLength?: number;
  signal?: AbortSignal;
}

/**
 * A reply to a message the user did not send: the chat's prompt with `input` as the last user
 * message (TavernHelper's `generate`).
 */
export async function generateWithInput(request: InputRequest): Promise<{ text: string; reasoning: string }> {
  const connection = activeConnection();
  if (!connection) throw new Error(t('chat.noConnection'));
  const input = context();
  await activeFormatting();
  let messages = [...input.messages];
  if (request.maxHistory !== undefined && request.maxHistory >= 0) {
    messages = request.maxHistory === 0 ? [] : messages.slice(-request.maxHistory);
  }
  if (request.input) {
    messages.push(unsentUserMessage(input.chat.id, chat.userName, request.input, messages.length));
  }
  const prepared = await prepare(
    { ...input, type: 'normal', messages, responseLength: request.responseLength },
    connection,
  );
  await keepVariables(input);
  const meta = { ...metaFor(connection, input, prepared.model, prepared.stream), type: 'normal' as const };
  const output = await send(prepared.http, meta, prepared.stream, connection.secretId, request.signal);
  const scripts = input.regexScripts;
  const { text, reasoning } = finalizeOutput(output, meta, prepared.stoppingStrings, (raw, placement) =>
    scripts.length ? chat.applyRegex(raw, placement) : raw,
  );
  return { text, reasoning };
}
