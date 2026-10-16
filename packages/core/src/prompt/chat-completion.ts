/**
 * Chat Completion prompt assembly — a port of SillyTavern's `prepareOpenAIMessages`
 * (openai.js / PromptManager.js). Kept structurally close to the original so behaviour can be
 * compared request-for-request (see tools/st-diff).
 */

import {
  INJECTION_ABSOLUTE,
  NamesBehavior,
  promptOrderFor,
  type ChatCompletionPreset,
  type PromptDefinition,
} from './preset.ts';
import {
  ExtensionPromptPosition,
  ExtensionPromptRole,
  InjectKeys,
  joinExtensionPrompts,
  MAX_INJECTION_DEPTH,
  type ChatMessage,
  type ChatRole,
  type ExtensionPrompt,
  type GenerationType,
} from './types.ts';
import { stringFormat } from '../util/text.ts';
import { imageTokenCost, TOKENS_PER_IMAGE, type MediaAttachment, type MediaInlining } from './media.ts';
import type { HistoryPrompt } from './messages.ts';
import { toolsForRequest, ToolReasoningMode, type ToolDefinition, type ToolInvocation } from '../tools.ts';

/** Counts the tokens of one message (OpenAI accounting incl. per-message overhead). */
export type MessageTokenCounter = (message: ChatMessage) => number | Promise<number>;

export interface ChatCompletionInput {
  type: GenerationType;
  preset: ChatCompletionPreset;
  /** Prompt order list to use (SillyTavern keeps a global list under id 100001). */
  promptOrderId?: number | string;
  isGroup: boolean;
  charDescription: string;
  charPersonality: string;
  scenario: string;
  worldInfoBefore: string;
  worldInfoAfter: string;
  /** "Start reply with" text (an assistant prefix at the end). */
  bias: string;
  quietPrompt: string;
  /** For `continue`: the text of the message being continued. */
  cyclePrompt: string;
  /** Character card system prompt (replaces Main unless the prompt forbids overrides). */
  systemPromptOverride: string;
  /** Character post-history instructions (replaces the jailbreak prompt). */
  jailbreakPromptOverride: string;
  extensionPrompts: Readonly<Record<string, ExtensionPrompt>>;
  /** Persona description when its position is "in prompt" (otherwise empty). */
  personaDescription: string;
  /** Chat history in chronological order, already in message form (see `toPromptMessages`). */
  messages: HistoryPrompt[];
  /** Example dialogue blocks (see `examplesToMessages`). */
  messageExamples: ChatMessage[][];
  pinExamples: boolean;
  /** Macro substitution; `original` is the text an override replaces. */
  substitute: (text: string, options?: { original?: string }) => string;
  countTokens: MessageTokenCounter;
  /** Whether the provider honours an assistant prefill (Claude). */
  supportsAssistantPrefill: boolean;
  /** Attachments the model takes inline (none when absent). */
  media?: MediaInlining;
  /** Tool calling: whether past calls go into the prompt, and the tools offered this time. */
  tools?: ToolPromptSettings;
}

export interface ToolPromptSettings {
  /** Past tool calls go into the prompt (`isToolCallingSupported`). */
  canUse: boolean;
  /** Tools offered with this request (`canPerformToolCalls`); their size is kept free. */
  offered?: readonly ToolDefinition[];
  /** Send reasoning signatures back (`isReasoningSignatureSupported`). */
  includeSignature: boolean;
  /** Forward reasoning between tool calls (`ToolReasoningMode`). */
  reasoningMode: string;
}

export interface PromptPart {
  identifier: string;
  messages: ChatMessage[];
  tokens: number;
}

export interface ChatCompletionResult {
  messages: ChatMessage[];
  /** Prompt broken down by section, for the prompt inspector. */
  parts: PromptPart[];
  tokens: number;
  /** Set when mandatory prompts alone exceed the context size. */
  error?: 'budget';
}

// ---------------------------------------------------------------------------------------------
// Messages and token budget (ChatCompletion / MessageCollection / Message in SillyTavern)

class PromptMessage {
  identifier: string;
  role: ChatRole;
  /** Undefined for a message that only calls tools (SillyTavern sends no content then). */
  content: ChatMessage['content'] | undefined;
  name?: string;
  tokens = 0;
  signature?: string;
  reasoning?: string;
  tool_calls?: ChatMessage['tool_calls'];

  private constructor(
    role: ChatRole | undefined,
    content: ChatMessage['content'] | undefined,
    identifier: string,
  ) {
    this.identifier = identifier;
    this.role = role ?? 'system';
    this.content = content;
  }

  static async create(
    role: ChatRole | undefined,
    content: ChatMessage['content'] | undefined,
    identifier: string,
    count: MessageTokenCounter,
  ): Promise<PromptMessage> {
    const message = new PromptMessage(role, content, identifier);
    if (typeof message.content === 'string' && message.content.length > 0) {
      message.tokens = await count({ role: message.role, content: message.content });
    }
    return message;
  }

  async setName(name: string, count: MessageTokenCounter): Promise<void> {
    this.name = name;
    this.tokens = await count({ role: this.role, content: this.content as ChatMessage['content'], name });
  }

  /** Records tool calls on this (assistant) message (`setToolCalls`). */
  async setToolCalls(
    invocations: readonly ToolInvocation[],
    includeSignature: boolean,
    includeReasoning: boolean,
    count: MessageTokenCounter,
  ): Promise<void> {
    this.tool_calls = invocations.map((i) => ({
      id: i.id,
      type: 'function',
      function: { arguments: i.parameters, name: i.name },
      ...(includeSignature && i.signature ? { signature: i.signature } : {}),
    }));
    const fallback = invocations.find(
      (i) => typeof i.reasoning === 'string' && i.reasoning.length > 0,
    )?.reasoning;
    this.reasoning = includeReasoning && fallback ? fallback : undefined;
    this.tokens = await count({
      role: this.role,
      tool_calls: JSON.stringify(this.tool_calls),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    } as unknown as ChatMessage);
  }

  /** The content as parts (`ensureContentIsArray`): text first, then inlined media. */
  #parts(): Exclude<ChatMessage['content'], string> {
    if (!Array.isArray(this.content))
      this.content = typeof this.content === 'string' ? [{ type: 'text', text: this.content }] : [];
    return this.content as Exclude<ChatMessage['content'], string>;
  }

  /** Inlines an attachment the model accepts (`addImage` / `addVideo` / `addAudio`). */
  async addMedia(item: MediaAttachment, media: MediaInlining): Promise<void> {
    const type = item.type ?? 'image';
    if (type === 'image' && media.image) {
      const parts = this.#parts();
      const image = await media.resolver.image(item.url, media.compress).catch(() => null);
      if (!image) return;
      parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: media.quality } });
      try {
        this.tokens += imageTokenCost(image.width, image.height, media.quality);
      } catch {
        this.tokens += TOKENS_PER_IMAGE;
      }
    }
    if (type === 'video' && media.video) {
      const parts = this.#parts();
      const video = await media.resolver.video(item.url).catch(() => null);
      if (!video) return;
      parts.push({ type: 'video_url', video_url: { url: video.dataUrl, detail: media.quality } });
      // Gemini's 263 tokens per second; about 40 seconds when the length is unknown.
      this.tokens += 263 * (video.duration ? Math.ceil(video.duration) : 40);
    }
    if (type === 'audio' && media.audio) {
      const parts = this.#parts();
      const audio = await media.resolver.audio(item.url).catch(() => null);
      if (!audio) return;
      parts.push({ type: 'audio_url', audio_url: { url: audio.dataUrl } });
      // 32 tokens per second; about five minutes when the length is unknown.
      this.tokens += 32 * (audio.duration ? Math.ceil(audio.duration) : 300);
    }
  }

  toChat(): ChatMessage {
    return {
      role: this.role,
      content: this.content as ChatMessage['content'],
      ...(this.name ? { name: this.name } : {}),
      ...(this.tool_calls ? { tool_calls: this.tool_calls } : {}),
      ...(this.role === 'tool' ? { tool_call_id: this.identifier } : {}),
      ...(this.signature ? { signature: this.signature } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    };
  }

  isEmpty(): boolean {
    return !this.content && !this.tool_calls;
  }

  getTokens(): number {
    return this.tokens;
  }
}

class MessageCollection {
  identifier: string;
  collection: (PromptMessage | MessageCollection)[] = [];

  constructor(identifier: string, ...items: (PromptMessage | MessageCollection)[]) {
    this.identifier = identifier;
    this.collection.push(...items);
  }

  add(item: PromptMessage | MessageCollection): void {
    this.collection.push(item);
  }

  getTokens(): number {
    return this.collection.reduce((sum, m) => sum + m.getTokens(), 0);
  }

  flatten(): PromptMessage[] {
    return this.collection.flatMap((m) => (m instanceof MessageCollection ? m.flatten() : [m]));
  }

  getChat(): ChatMessage[] {
    return this.collection.flatMap((m) => (m instanceof PromptMessage && !m.isEmpty() ? [m.toChat()] : []));
  }
}

class TokenBudgetExceeded extends Error {}

class Completion {
  budget = 0;
  /** Top-level collections; indices follow the prompt order, so the array may have holes. */
  root: (MessageCollection | PromptMessage | undefined)[] = [];

  setBudget(context: number, response: number): void {
    this.budget = context - response;
  }

  canAfford(item: { getTokens(): number }): boolean {
    return this.budget - item.getTokens() >= 0;
  }

  canAffordAll(items: { getTokens(): number }[]): boolean {
    return this.budget - items.reduce((sum, m) => sum + m.getTokens(), 0) >= 0;
  }

  reserve(item: { getTokens(): number } | number): void {
    this.budget -= typeof item === 'number' ? item : item.getTokens();
  }

  free(item: { getTokens(): number }): void {
    this.budget += item.getTokens();
  }

  add(collection: MessageCollection, position: number | null = null): void {
    if (!this.canAfford(collection)) throw new TokenBudgetExceeded(collection.identifier);
    if (position !== null && position !== -1) this.root[position] = collection;
    else this.root.push(collection);
    this.budget -= collection.getTokens();
  }

  #index(identifier: string): number {
    const index = this.root.findIndex((c) => c?.identifier === identifier);
    if (index < 0) throw new Error(`Identifier ${identifier} not found`);
    return index;
  }

  has(identifier: string): boolean {
    return this.root.some((c) => c?.identifier === identifier);
  }

  insert(message: PromptMessage, identifier: string, position: 'start' | 'end' | number = 'end'): void {
    if (!this.canAfford(message)) throw new TokenBudgetExceeded(message.identifier);
    const target = this.root[this.#index(identifier)] as MessageCollection;
    if (message.isEmpty()) return;
    if (position === 'start') target.collection.unshift(message);
    else if (position === 'end') target.collection.push(message);
    else target.collection.splice(position, 0, message);
    this.budget -= message.getTokens();
  }

  async squashSystemMessages(count: MessageTokenCounter): Promise<void> {
    const exclude = ['newMainChat', 'newChat', 'groupNudge'];
    const flat = this.root.flatMap((c) => (c instanceof MessageCollection ? c.flatten() : c ? [c] : []));
    const squash = (m: PromptMessage) => !exclude.includes(m.identifier) && m.role === 'system' && !m.name;
    const out: PromptMessage[] = [];
    let last: PromptMessage | null = null;
    for (const message of flat) {
      if (message.role === 'system' && !message.content) continue;
      if (squash(message) && last && squash(last)) {
        last.content += '\n' + message.content;
        last.tokens = await count({ role: last.role, content: last.content as ChatMessage['content'] });
      } else {
        out.push(message);
        last = message;
      }
    }
    this.root = out;
  }

  getChat(): ChatMessage[] {
    const chat: ChatMessage[] = [];
    for (const item of this.root) {
      if (item instanceof MessageCollection) chat.push(...item.getChat());
      else if (item instanceof PromptMessage && !item.isEmpty()) chat.push(item.toChat());
    }
    return chat;
  }

  parts(): PromptPart[] {
    const parts: PromptPart[] = [];
    for (const item of this.root) {
      if (item instanceof MessageCollection) {
        const messages = item.getChat();
        if (messages.length) parts.push({ identifier: item.identifier, messages, tokens: item.getTokens() });
      } else if (item instanceof PromptMessage && !item.isEmpty()) {
        parts.push({ identifier: item.identifier, messages: [item.toChat()], tokens: item.getTokens() });
      }
    }
    return parts;
  }
}

// ---------------------------------------------------------------------------------------------
// Prompt collection (PromptManager.getPromptCollection + preparePromptsForChatCompletion)

interface Prompt extends PromptDefinition {
  extension?: boolean;
  /** Relative extension prompts: 'start' | 'end' of the main prompt. */
  position?: 'start' | 'end' | false;
}

class PromptList {
  collection: Prompt[] = [];
  overridden: string[] = [];

  get(id: string): Prompt | undefined {
    return this.collection.find((p) => p?.identifier === id);
  }

  index(id: string): number {
    return this.collection.findIndex((p) => p?.identifier === id);
  }

  has(id: string): boolean {
    return this.index(id) !== -1;
  }
}

function promptPosition(position: number): 'start' | 'end' | false {
  if (position === ExtensionPromptPosition.BEFORE_PROMPT) return 'start';
  if (position === ExtensionPromptPosition.IN_PROMPT) return 'end';
  return false;
}

function promptRole(role: number): 'system' | 'user' | 'assistant' {
  if (role === ExtensionPromptRole.USER) return 'user';
  if (role === ExtensionPromptRole.ASSISTANT) return 'assistant';
  return 'system';
}

function formatWorldInfo(value: string, format: string): string {
  if (!value) return '';
  if (!format.trim()) return value;
  return stringFormat(format, value);
}

export async function buildChatCompletion(input: ChatCompletionInput): Promise<ChatCompletionResult> {
  const { preset, substitute, countTokens: count } = input;
  const type = input.type || 'normal';
  const order = promptOrderFor(preset, input.promptOrderId);
  const definitions = new Map(preset.prompts.filter(Boolean).map((p) => [p.identifier, p]));
  const isDisabled = (id: string) => {
    const entry = order.find((e) => e.identifier === id);
    return entry ? !entry.enabled : false;
  };
  const prepare = (prompt: Prompt, original?: string): Prompt => ({
    ...prompt,
    content:
      original === undefined
        ? substitute(prompt.content ?? '')
        : substitute(prompt.content ?? '', { original }),
    injection_order: prompt.injection_order ?? 100,
    injection_trigger: prompt.injection_trigger ?? [],
    extension: prompt.extension ?? false,
  });

  // getPromptCollection
  const prompts = new PromptList();
  for (const entry of order) {
    const prompt = definitions.get(entry.identifier);
    if (!prompt) continue;
    const triggers = prompt.injection_trigger;
    const triggered = !Array.isArray(triggers) || triggers.length === 0 || triggers.includes(type);
    if (entry.enabled && triggered) prompts.collection.push(prepare(prompt));
    else if (entry.identifier === 'main')
      prompts.collection.push(prepare({ ...structuredClone(prompt), content: '' }));
  }

  // System prompts and extension prompts merged into the collection
  const scenarioText =
    input.scenario && preset.scenario_format ? substitute(preset.scenario_format) : input.scenario || '';
  const personalityText =
    input.charPersonality && preset.personality_format
      ? substitute(preset.personality_format)
      : input.charPersonality || '';
  const groupNudge = substitute(preset.group_nudge_prompt);
  const impersonation = preset.impersonation_prompt ? substitute(preset.impersonation_prompt) : '';
  const systemPrompts: Prompt[] = [
    {
      role: 'system',
      content: formatWorldInfo(input.worldInfoBefore, preset.wi_format),
      identifier: 'worldInfoBefore',
    },
    {
      role: 'system',
      content: formatWorldInfo(input.worldInfoAfter, preset.wi_format),
      identifier: 'worldInfoAfter',
    },
    { role: 'system', content: input.charDescription, identifier: 'charDescription' },
    { role: 'system', content: personalityText, identifier: 'charPersonality' },
    { role: 'system', content: scenarioText, identifier: 'scenario' },
    { role: 'system', content: impersonation, identifier: 'impersonate' },
    { role: 'system', content: input.quietPrompt, identifier: 'quietPrompt' },
    { role: 'system', content: groupNudge, identifier: 'groupNudge' },
    { role: 'assistant', content: input.bias, identifier: 'bias' },
  ];
  const ext = input.extensionPrompts;
  const known: [string, string, boolean][] = [
    [InjectKeys.MEMORY, 'summary', true],
    [InjectKeys.AUTHORS_NOTE, 'authorsNote', true],
    [InjectKeys.VECTORS, 'vectorsMemory', false],
    [InjectKeys.VECTORS_DATA_BANK, 'vectorsDataBank', true],
    [InjectKeys.SMART_CONTEXT, 'smartContext', false],
  ];
  for (const [key, identifier, useRole] of known) {
    const p = ext[key];
    if (p?.value) {
      systemPrompts.push({
        role: useRole ? promptRole(p.role) : 'system',
        content: p.value,
        identifier,
        position: promptPosition(p.position),
      });
    }
  }
  if (input.personaDescription) {
    systemPrompts.push({
      role: 'system',
      content: input.personaDescription,
      identifier: 'personaDescription',
    });
  }
  const knownKeys = new Set<string>([
    ...known.map(([k]) => k),
    InjectKeys.PERSONA_DESCRIPTION,
    InjectKeys.QUIET_PROMPT,
    InjectKeys.DEPTH_PROMPT,
  ]);
  for (const key of Object.keys(ext)) {
    const p = ext[key]!;
    if (knownKeys.has(key) || !p.value) continue;
    if (
      p.position !== ExtensionPromptPosition.BEFORE_PROMPT &&
      p.position !== ExtensionPromptPosition.IN_PROMPT
    )
      continue;
    systemPrompts.push({
      identifier: key.replace(/\W/g, '_'),
      position: promptPosition(p.position),
      role: promptRole(p.role),
      content: p.value,
      extension: true,
    });
  }
  for (const prompt of systemPrompts) {
    const existing = prompts.get(prompt.identifier);
    if (existing) {
      prompt.injection_position = existing.injection_position ?? prompt.injection_position;
      prompt.injection_depth = existing.injection_depth ?? prompt.injection_depth;
      prompt.injection_order = existing.injection_order ?? prompt.injection_order;
      prompt.role = existing.role ?? prompt.role;
    }
    const prepared = prepare(prompt);
    const index = prompts.index(prompt.identifier);
    if (index !== -1) prompts.collection[index] = prepared;
    else prompts.collection.push(prepared);
  }
  for (const [id, override] of [
    ['main', input.systemPromptOverride],
    ['jailbreak', input.jailbreakPromptOverride],
  ] as const) {
    const prompt = prompts.get(id);
    if (override && prompt && prompt.forbid_overrides !== true && !isDisabled(id)) {
      const original = prompt.content ?? '';
      prompts.collection[prompts.index(id)] = prepare({ ...prompt, content: override }, original);
      prompts.overridden.push(id);
    }
  }

  // populateChatCompletion
  const completion = new Completion();
  completion.setBudget(preset.openai_max_context, preset.openai_max_tokens);
  let messages = input.messages.map((m) => ({ ...m })).reverse() as (HistoryPrompt & {
    injected?: boolean;
  })[];

  try {
    const addToCompletion = async (source: string, target: string | null = null) => {
      if (!prompts.has(source)) return;
      if (isDisabled(source) && source !== 'main') return;
      const prompt = prompts.get(source)!;
      if (prompt.injection_position === INJECTION_ABSOLUTE) return;
      const index = target ? prompts.index(target) : prompts.index(source);
      const message = await PromptMessage.create(prompt.role, prompt.content, prompt.identifier, count);
      completion.add(new MessageCollection(source, message), index);
    };

    completion.reserve(3);
    for (const id of [
      'worldInfoBefore',
      'main',
      'worldInfoAfter',
      'charDescription',
      'charPersonality',
      'scenario',
      'personaDescription',
    ]) {
      await addToCompletion(id);
    }

    const controlPrompts = new MessageCollection('controlPrompts');
    const impersonate = prompts.get('impersonate');
    if (type === 'impersonate' && impersonate) {
      controlPrompts.add(
        await PromptMessage.create(impersonate.role, impersonate.content, impersonate.identifier, count),
      );
    }
    const quiet = prompts.get('quietPrompt');
    if (quiet?.content)
      controlPrompts.add(await PromptMessage.create(quiet.role, quiet.content, quiet.identifier, count));
    completion.reserve(controlPrompts);

    const userRelative = prompts.collection
      .filter((p) => p && p.system_prompt === false && p.injection_position !== INJECTION_ABSOLUTE)
      .map((p) => p.identifier);
    const absolutePrompts = prompts.collection.filter(
      (p) => p && p.injection_position === INJECTION_ABSOLUTE,
    );
    for (const id of ['nsfw', 'jailbreak', ...userRelative]) await addToCompletion(id);
    if (prompts.has('enhanceDefinitions')) await addToCompletion('enhanceDefinitions');
    if (input.bias && input.bias.trim().length) await addToCompletion('bias');

    const injectToMain = async (prompt: Prompt, position: 'start' | 'end') => {
      if (completion.has('main')) {
        const message = await PromptMessage.create(prompt.role, prompt.content, prompt.identifier, count);
        completion.insert(message, 'main', position);
      } else {
        const indexOfMain = absolutePrompts.findIndex((p) => p.identifier === 'main');
        if (indexOfMain >= 0) {
          const main = absolutePrompts[indexOfMain]!;
          absolutePrompts.splice(position === 'end' ? indexOfMain + 1 : indexOfMain, 0, {
            ...prompt,
            role: main.role,
            injection_position: main.injection_position,
            injection_depth: main.injection_depth,
            injection_order: main.injection_order,
          });
        }
      }
    };
    for (const key of ['summary', 'authorsNote', 'vectorsMemory', 'vectorsDataBank', 'smartContext']) {
      const prompt = prompts.get(key);
      if (prompt?.position) await injectToMain(prompt, prompt.position);
    }
    for (const prompt of prompts.collection.filter((p) => p?.extension && p.position)) {
      await injectToMain(prompt, prompt.position as 'start' | 'end');
    }

    // The tools sent with the request take room too.
    if (input.tools?.offered) {
      const toolData = JSON.stringify(toolsForRequest(input.tools.offered));
      completion.reserve(await count({ role: 'user', content: toolData }));
    }

    // Continue with prefill: the continued message moves to the end as a prefill.
    if (type === 'continue' && preset.continue_prefill && messages.length) {
      const chatMessage = messages.shift()!;
      const isAssistant = chatMessage.role === 'assistant';
      const prefill =
        isAssistant && input.supportsAssistantPrefill ? substitute(preset.assistant_prefill) : '';
      const content = [prefill, chatMessage.content].filter((x) => x).join('\n\n');
      const continueMessage = await PromptMessage.create(chatMessage.role, content, 'continuePrefill', count);
      if (chatMessage.name && preset.names_behavior === NamesBehavior.COMPLETION) {
        await continueMessage.setName(sanitizeName(chatMessage.name), count);
      }
      controlPrompts.add(continueMessage);
      completion.reserve(continueMessage);
    }

    messages = injectInChat(absolutePrompts, messages, ext, substitute);

    const historyArgs = { input, prompts, completion, messages, type, count, substitute } as const;
    if (input.pinExamples) {
      await populateExamples(historyArgs);
      await populateHistory(historyArgs);
    } else {
      await populateHistory(historyArgs);
      await populateExamples(historyArgs);
    }

    completion.free(controlPrompts);
    if (controlPrompts.collection.length) completion.add(controlPrompts);
  } catch (error) {
    if (!(error instanceof TokenBudgetExceeded)) throw error;
    return { messages: completion.getChat(), parts: completion.parts(), tokens: 0, error: 'budget' };
  }

  if (preset.squash_system_messages) await completion.squashSystemMessages(count);
  const parts = completion.parts();
  return { messages: completion.getChat(), parts, tokens: parts.reduce((s, p) => s + p.tokens, 0) };
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
}

function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9_]{1,64}$/.test(name);
}

/** In-chat (absolute) prompts and depth injections (`populationInjectionPrompts`). */
function injectInChat(
  absolutePrompts: Prompt[],
  reversedMessages: (ChatMessage & { injected?: boolean })[],
  ext: Readonly<Record<string, ExtensionPrompt>>,
  substitute: (text: string) => string,
): (ChatMessage & { injected?: boolean })[] {
  const messages = [...reversedMessages];
  let inserted = 0;
  const roleIds: Record<string, number> = { system: 0, user: 1, assistant: 2 };
  const depths = new Set<number>();
  for (const p of absolutePrompts) if (p.content) depths.add(p.injection_depth ?? 4);
  for (const p of Object.values(ext))
    if (p.position === ExtensionPromptPosition.IN_CHAT && p.value) depths.add(p.depth);
  const sortedDepths = [...depths].filter((d) => d >= 0 && d <= MAX_INJECTION_DEPTH).sort((a, b) => a - b);

  for (const depth of sortedDepths) {
    const depthPrompts = absolutePrompts.filter((p) => (p.injection_depth ?? 4) === depth && p.content);
    const roleMessages: (ChatMessage & { injected?: boolean })[] = [];
    const orderGroups: Record<string, Prompt[]> = { '100': [] };
    for (const prompt of depthPrompts)
      (orderGroups[String(prompt.injection_order ?? 100)] ??= []).push(prompt);
    const orders = Object.keys(orderGroups).sort((a, b) => Number(b) - Number(a));
    for (const order of orders) {
      for (const role of ['system', 'user', 'assistant'] as const) {
        const rolePrompts = orderGroups[order]!.filter((p) => p.role === role)
          .map((p) => p.content)
          .join('\n');
        const extensionPrompt =
          order === '100'
            ? substitute(
                joinExtensionPrompts(ext, ExtensionPromptPosition.IN_CHAT, {
                  depth,
                  role: roleIds[role],
                  wrap: false,
                }),
              )
            : '';
        const joint = [rolePrompts, extensionPrompt]
          .filter((x) => x)
          .map((x) => x!.trim())
          .join('\n');
        if (joint && joint.length) roleMessages.push({ role, content: joint, injected: true });
      }
    }
    if (roleMessages.length) {
      messages.splice(depth + inserted, 0, ...roleMessages);
      inserted += roleMessages.length;
    }
  }
  return messages.reverse();
}

interface HistoryArgs {
  input: ChatCompletionInput;
  prompts: PromptList;
  completion: Completion;
  messages: (HistoryPrompt & { injected?: boolean })[];
  type: GenerationType;
  count: MessageTokenCounter;
  substitute: (text: string) => string;
}

async function populateHistory({
  input,
  prompts,
  completion,
  messages,
  type,
  count,
  substitute,
}: HistoryArgs) {
  if (!prompts.has('chatHistory')) return;
  const preset = input.preset;
  completion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

  const newChat = input.isGroup ? preset.new_group_chat_prompt : preset.new_chat_prompt;
  const newChatMessage = await PromptMessage.create('system', substitute(newChat), 'newMainChat', count);
  completion.reserve(newChatMessage);

  let groupNudgeMessage: PromptMessage | null = null;
  const nudge = prompts.get('groupNudge');
  if (input.isGroup && nudge && type !== 'impersonate') {
    groupNudgeMessage = await PromptMessage.create(nudge.role, nudge.content, nudge.identifier, count);
    completion.reserve(groupNudgeMessage);
  }

  let continueCollection: MessageCollection | null = null;
  if (type === 'continue' && input.cyclePrompt && !preset.continue_prefill) {
    continueCollection = new MessageCollection('continueNudge');
    const index = messages.findLastIndex((m) => !m.injected);
    if (index >= 0) {
      const continued = messages.splice(index, 1)[0]!;
      const content =
        typeof continued.content === 'string' ? substitute(continued.content) : continued.content;
      continueCollection.add(await PromptMessage.create(continued.role, content, 'continued', count));
    }
    const nudgeText = substitute(
      preset.continue_nudge_prompt.replaceAll('{{lastChatMessage}}', String(input.cyclePrompt).trim()),
    );
    continueCollection.add(await PromptMessage.create('system', nudgeText, 'continueNudge', count));
    completion.reserve(continueCollection);
  }

  const last = messages[messages.length - 1];
  const emptyReplacement = await PromptMessage.create(
    'user',
    preset.send_if_empty,
    'emptyUserMessageReplacement',
    count,
  );
  if (last && last.role === 'assistant' && preset.send_if_empty && completion.canAfford(emptyReplacement)) {
    completion.insert(emptyReplacement, 'chatHistory');
  }

  const tools = input.tools;
  const reasoningMode = tools?.reasoningMode ?? ToolReasoningMode.DISABLED;
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const pool = [...messages].reverse();
  for (let index = 0; index < pool.length; index++) {
    const source = pool[index]!;
    const content = typeof source.content === 'string' ? substitute(source.content) : source.content;
    const message = await PromptMessage.create(
      source.role,
      content,
      `chatHistory-${messages.length - index}`,
      count,
    );
    if (preset.names_behavior === NamesBehavior.COMPLETION && source.name) {
      await message.setName(isValidName(source.name) ? source.name : sanitizeName(source.name), count);
    }
    if (input.media && source.media?.media.length) {
      const { media, display, index } = source.media;
      for (const item of display === 'gallery' ? [media[index]!] : media)
        await message.addMedia(item, input.media);
    }

    // A message that records tool calls becomes the call and its results.
    if (tools?.canUse && Array.isArray(source.invocations)) {
      const at = messages.indexOf(source);
      const eligible = reasoningMode !== ToolReasoningMode.DISABLED && at > lastUser;
      const previousReasoning = eligible ? toolChainReasoning(messages, at, lastUser, reasoningMode) : '';
      const invocations = source.invocations.map((invocation) => {
        const clone = { ...invocation };
        if (!eligible) delete clone.reasoning;
        else if (previousReasoning && !clone.reasoning) clone.reasoning = previousReasoning;
        return clone;
      });
      const call = await PromptMessage.create(
        message.role,
        undefined,
        `toolCall-${message.identifier}`,
        count,
      );
      const results = await Promise.all(
        invocations
          .slice()
          .reverse()
          .map((i) => PromptMessage.create('tool', i.result || '[No content]', i.id, count)),
      );
      await call.setToolCalls(
        invocations,
        tools.includeSignature,
        reasoningMode !== ToolReasoningMode.DISABLED,
        count,
      );
      if (!completion.canAffordAll([call, ...results])) break;
      for (const result of results) completion.insert(result, 'chatHistory', 'start');
      completion.insert(call, 'chatHistory', 'start');
      continue;
    }

    if (tools?.includeSignature && source.signature) message.signature = source.signature;
    if (completion.canAfford(message)) completion.insert(message, 'chatHistory', 'start');
    else break;
  }

  completion.free(newChatMessage);
  completion.insert(newChatMessage, 'chatHistory', 'start');
  if (input.isGroup && groupNudgeMessage) {
    completion.free(groupNudgeMessage);
    completion.insert(groupNudgeMessage, 'chatHistory', 'end');
  }
  if (type === 'continue' && continueCollection) {
    completion.free(continueCollection);
    completion.add(continueCollection, -1);
  }
}

/** The reasoning of the assistant text a tool call follows (SillyTavern's tool reasoning modes). */
function toolChainReasoning(
  messages: readonly (HistoryPrompt & { injected?: boolean })[],
  at: number,
  lastUser: number,
  mode: string,
): string {
  const hasText = (m: HistoryPrompt | undefined) =>
    m?.role === 'assistant' &&
    !Array.isArray(m.invocations) &&
    typeof m.content === 'string' &&
    m.content.trim().length > 0;
  for (let i = at - 1; i > lastUser; i--) {
    const candidate = messages[i];
    if (mode === ToolReasoningMode.ACTIVE_CHAIN) {
      // Only the reasoning of the text right before the chain of calls.
      if (candidate?.role === 'tool') continue;
      if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) continue;
      return hasText(candidate) ? String(candidate!.reasoning ?? '') : '';
    }
    if (mode === ToolReasoningMode.SINCE_LAST_USER && hasText(candidate) && candidate!.reasoning) {
      return String(candidate!.reasoning);
    }
  }
  return '';
}

async function populateExamples({ input, prompts, completion, count, substitute }: HistoryArgs) {
  if (!prompts.has('dialogueExamples')) return;
  completion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
  const examples = input.messageExamples;
  if (!examples.length) return;
  const newExampleChat = await PromptMessage.create(
    'system',
    substitute(input.preset.new_example_chat_prompt),
    'newChat',
    count,
  );
  for (const [dialogueIndex, dialogue] of examples.entries()) {
    const chatMessages: PromptMessage[] = [];
    for (const [promptIndex, prompt] of dialogue.entries()) {
      const message = await PromptMessage.create(
        'system',
        prompt.content || '',
        `dialogueExamples ${dialogueIndex}-${promptIndex}`,
        count,
      );
      await message.setName(prompt.name ?? '', count);
      chatMessages.push(message);
    }
    if (!completion.canAffordAll([newExampleChat, ...chatMessages])) break;
    completion.insert(newExampleChat, 'dialogueExamples');
    for (const message of chatMessages) completion.insert(message, 'dialogueExamples');
  }
}
