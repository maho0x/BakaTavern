import type { ChangeEvent, Character, Chat, JobInfo, Message, Persona, Swipe } from '@bakatavern/api-client';
import { ApiError, randomId } from '@bakatavern/api-client';
import {
  getProvider,
  greetingSwipes,
  type GenerationOutput,
  type GenerationType,
  type ProviderDefinition,
} from '@bakatavern/core';

import { api } from '../api.ts';
import {
  activeConnection,
  finalizeOutput,
  macros,
  newAssistantMessage,
  prepare,
  readResponse,
  swipeInfo,
  type JobMeta,
  type Target,
} from '../generation/pipeline.ts';
import { t } from '../i18n/index.svelte.ts';
import { library } from './library.svelte.ts';
import { chatDefaults, noteDefaults, personaDefaults } from './prefs.ts';
import { settings } from './settings.svelte.ts';
import { errorText, ui } from './ui.svelte.ts';

export interface Generation {
  type: GenerationType;
  target: Target;
  jobId: string | null;
  text: string;
  reasoning: string;
  startedAt: number;
  controller: AbortController;
}

const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage unavailable
    }
  },
};

/** SillyTavern-style chat file name: `Name - 2026-10-14@23h56m12s`. */
function chatTitle(name: string, date = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${name} - ${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}@${p(date.getHours())}h${p(date.getMinutes())}m${p(date.getSeconds())}s`;
}

function activeText(message: Message) {
  return message.swipes[message.swipeId]?.content ?? '';
}

class ChatStore {
  characterId = $state<string | null>(null);
  character = $state<Character | null>(null);
  chats = $state<Chat[]>([]);
  chat = $state<Chat | null>(null);
  messages = $state<Message[]>([]);
  recent = $state<Chat[]>([]);
  loading = $state(false);
  generation = $state<Generation | null>(null);
  draft = $state('');

  /** Persona in use: chat lock, character lock, default, then the first persona. */
  persona = $derived.by((): Persona | undefined => {
    const prefs = settings.get('persona', personaDefaults);
    const locked = this.chat?.metadata.persona as string | undefined;
    return (
      library.persona(locked) ??
      library.personas.find((p) => locked && p.sourceFile === locked) ??
      library.persona(this.characterId ? prefs.characterPersona[this.characterId] : null) ??
      library.persona(prefs.defaultPersonaId) ??
      library.personas.find((p) => p.isDefault) ??
      library.personas[0]
    );
  });

  userName = $derived(this.persona?.name ?? 'User');

  async restoreLast() {
    const characterId = store.get('bt.lastCharacter');
    if (characterId && library.character(characterId))
      await this.openCharacter(characterId, store.get('bt.lastChat'));
  }

  async openCharacter(id: string, preferChatId?: string | null) {
    if (this.generation) return;
    this.loading = true;
    try {
      const [character, chats] = await Promise.all([api.getCharacter(id), api.listChats(id)]);
      this.characterId = id;
      this.character = character;
      this.chats = chats;
      store.set('bt.lastCharacter', id);
      const chatId = chats.find((c) => c.id === preferChatId)?.id ?? chats[0]?.id;
      if (chatId) await this.openChat(chatId);
      else await this.newChat();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      this.loading = false;
    }
    if (ui.narrow) ui.libraryOpen = false;
  }

  async reloadCharacter() {
    if (this.characterId) this.character = await api.getCharacter(this.characterId);
  }

  async openChat(id: string) {
    const [chat, messages] = await Promise.all([api.getChat(id), api.messages(id)]);
    this.chat = chat;
    this.messages = messages;
    store.set('bt.lastChat', id);
    void this.recoverJobs();
  }

  async newChat() {
    const character = this.character;
    if (!character) return;
    const card = $state.snapshot(character.card);
    const name = character.name;
    const greetings = greetingSwipes(card, macros, { user: this.userName, char: name });
    const now = new Date().toISOString();
    const note = settings.get('note', noteDefaults);
    const created = await api.createChat({
      characterId: character.id,
      title: chatTitle(name),
      metadata: {
        note_prompt: note.defaultPrompt,
        note_interval: note.defaultInterval,
        note_position: note.defaultPosition,
        note_depth: note.defaultDepth,
        note_role: note.defaultRole,
      },
      messages: greetings.length
        ? [
            {
              role: 'assistant',
              name,
              swipes: greetings.map((g) => ({ content: g, info: { send_date: now, extra: {} } })),
              sendDate: now,
            },
          ]
        : [],
    });
    this.chats.unshift(created.chat);
    this.chat = created.chat;
    this.messages = created.messages;
    store.set('bt.lastChat', created.chat.id);
  }

  async renameChat(title: string) {
    if (!this.chat) return;
    this.chat = await api.updateChat(this.chat.id, { title, rev: this.chat.rev });
    this.chats = this.chats.map((c) => (c.id === this.chat!.id ? this.chat! : c));
  }

  async deleteChat(id: string) {
    await api.deleteChat(id);
    this.chats = this.chats.filter((c) => c.id !== id);
    if (this.chat?.id === id) {
      this.chat = null;
      this.messages = [];
      if (this.chats[0]) await this.openChat(this.chats[0].id);
      else await this.newChat();
    }
  }

  async updateMetadata(patch: Record<string, unknown>) {
    if (!this.chat) return;
    const metadata = { ...$state.snapshot(this.chat.metadata), ...patch };
    try {
      this.chat = await api.updateChat(this.chat.id, { metadata, rev: this.chat.rev });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        const fresh = await api.getChat(this.chat.id);
        this.chat = await api.updateChat(fresh.id, {
          metadata: { ...fresh.metadata, ...patch },
          rev: fresh.rev,
        });
      } else {
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sending and generating

  async send(text: string) {
    if (this.generation || !this.chat) return;
    if (text.trim()) {
      const [message] = await api.addMessages(this.chat.id, [
        {
          role: 'user',
          name: this.userName,
          swipes: [{ content: text, info: {} }],
          sendDate: new Date().toISOString(),
        },
      ]);
      this.messages.push(message!);
      this.draft = '';
    }
    await this.generate('normal');
  }

  async regenerate() {
    if (this.generation || !this.chat) return;
    const last = this.messages.at(-1);
    if (last?.role === 'assistant' && this.messages.length > 1) {
      await api.deleteMessages(this.chat.id, { ids: [last.id] });
      this.messages.pop();
    }
    await this.generate('regenerate');
  }

  async generate(type: GenerationType) {
    const chat = this.chat;
    const character = this.character;
    if (this.generation || !chat || !character) return;
    const connection = activeConnection();
    if (!connection) {
      ui.toast(t('chat.noConnection'), 'error');
      ui.panel = 'connection';
      return;
    }
    const last = this.messages.at(-1);
    let target: Target;
    if (type === 'swipe' && last) target = { kind: 'swipe', messageId: last.id };
    else if (type === 'continue' && last) target = { kind: 'continue', messageId: last.id };
    else if (type === 'impersonate') target = { kind: 'impersonate' };
    else target = { kind: 'new' };

    // The job id is ours from the start, so Stop works even before the provider answers.
    const jobId = randomId();
    const controller = new AbortController();
    this.generation = { type, target, jobId, text: '', reasoning: '', startedAt: Date.now(), controller };
    const metadata = $state.snapshot(chat.metadata) as Record<string, unknown>;
    try {
      const prepared = await prepare(
        {
          type,
          character: $state.snapshot(character) as Character,
          persona: this.persona,
          chat,
          metadata,
          messages: $state.snapshot(this.messages) as Message[],
        },
        connection,
      );
      if (prepared.prompt.error === 'budget') throw new Error(t('chat.budgetExceeded'));
      const meta: JobMeta = {
        type,
        target,
        providerId: connection.provider.id,
        model: connection.model,
        stream: prepared.request.stream,
        charName: character.name,
        personaName: this.userName,
        startedAt: new Date().toISOString(),
        continuedText: type === 'continue' && last ? activeText(last) : undefined,
      };
      const started = await api.startJob(
        {
          ...prepared.http,
          id: jobId,
          secretId: connection.secretId,
          chatId: chat.id,
          meta: meta as unknown as Record<string, unknown>,
        },
        controller.signal,
      );
      await this.#follow(
        jobId,
        started.response,
        meta,
        connection.provider,
        prepared.stoppingStrings,
        metadata,
      );
    } catch (error) {
      if (!controller.signal.aborted)
        ui.toast(t('chat.generationFailed', { message: errorText(error) }), 'error');
    } finally {
      this.generation = null;
      this.#afterGeneration();
    }
  }

  /**
   * Shows a job's response as it streams in, then stores the result. Used for new generations and
   * for jobs picked up after a reload or from another tab or device. Returns whether this tab
   * stored the result.
   */
  async #follow(
    jobId: string,
    response: Response,
    meta: JobMeta,
    provider: ProviderDefinition,
    stoppingStrings: readonly string[],
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const generation = this.generation!;
    const signal = generation.controller.signal;
    let partial: GenerationOutput = { text: '', reasoning: '' };
    let frame = 0;
    const show = () => {
      frame = 0;
      generation.text = partial.text;
      generation.reasoning = partial.reasoning;
      if (meta.target.kind === 'impersonate') this.draft = partial.text;
    };
    let output: GenerationOutput;
    try {
      output = await readResponse(
        response,
        provider,
        meta.stream,
        (o) => {
          partial = o;
          frame ||= requestAnimationFrame(show);
        },
        signal,
      );
      if (output.error) throw new Error(output.error);
    } catch (error) {
      cancelAnimationFrame(frame);
      if (signal.aborted) {
        // Stopped: keep what arrived so far.
        if (!partial.text.trim()) {
          void api.ackJob(jobId).catch(() => {});
          return false;
        }
        output = partial;
      } else if (error instanceof TypeError) {
        // The connection dropped. The server keeps generating; the reply is recovered later.
        ui.toast(t('chat.connectionLost'));
        return false;
      } else {
        ui.toast(t('chat.generationFailed', { message: errorText(error) }), 'error');
        void api.ackJob(jobId).catch(() => {});
        return false;
      }
    }
    cancelAnimationFrame(frame);
    if (!signal.aborted && meta.stream) {
      // A broken upstream connection just ends the stream; the job knows whether it completed.
      const info = await api.jobInfo(jobId).catch(() => null);
      if (info?.status === 'failed') ui.toast(t('chat.incomplete', { message: info.error ?? '' }), 'error');
    }
    try {
      return await this.#store(jobId, meta, output, signal.aborted ? [] : stoppingStrings, metadata);
    } catch (error) {
      // The reply stays on the server and is picked up again once the server is reachable
      // (see session.refresh) or the chat is opened again.
      if (error instanceof TypeError) ui.toast(t('chat.connectionLost'));
      else ui.toast(t('chat.saveFailed', { message: errorText(error) }), 'error');
      return false;
    }
  }

  /** Stores a finished job's result, unless another tab or device is doing it. */
  async #store(
    jobId: string,
    meta: JobMeta,
    output: GenerationOutput,
    stoppingStrings: readonly string[],
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const claim = await api.claimJob(jobId);
    if (!claim.claimed) {
      // Show the result the other client stores; take over if it goes quiet.
      this.#pendingReload = true;
      if (!claim.handled) this.#retryRecovery();
      return false;
    }
    try {
      await this.#finish(meta, output, stoppingStrings, metadata);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'conflict')) throw error;
      // The message changed elsewhere meanwhile: build on the current version.
      await this.#reloadMessages();
      await this.#finish(meta, output, stoppingStrings, metadata);
    }
    await api.ackJob(jobId).catch(() => {});
    return true;
  }

  stop() {
    const generation = this.generation;
    if (!generation) return;
    generation.controller.abort();
    if (generation.jobId) void api.abortJob(generation.jobId).catch(() => {});
  }

  async #finish(
    meta: JobMeta,
    output: GenerationOutput,
    stoppingStrings: readonly string[],
    metadata?: Record<string, unknown>,
  ) {
    const chat = this.chat;
    if (!chat) return;
    const { text, reasoning } = finalizeOutput(output, meta, stoppingStrings);
    const target = meta.target;
    if (target.kind === 'impersonate') {
      this.draft = text;
    } else if (target.kind === 'new') {
      if (!text && !reasoning) {
        ui.toast(t('chat.emptyReply'));
      } else {
        const [message] = await api.addMessages(chat.id, [newAssistantMessage(meta, text, reasoning)]);
        this.messages.push(message!);
      }
    } else {
      const index = this.messages.findIndex((m) => m.id === target.messageId);
      const message = this.messages[index];
      if (!message) return;
      // Snapshot<unknown> collapses to never, so restate the element type.
      const swipes = $state.snapshot(message.swipes) as Swipe[];
      let swipeId = message.swipeId;
      const info = swipeInfo(meta, reasoning);
      if (target.kind === 'swipe') {
        swipes.push({ content: text, info });
        swipeId = swipes.length - 1;
      } else {
        const current = swipes[swipeId]!;
        const joiner = /\s$/.test(current.content) || /^\s/.test(text) ? '' : ' ';
        current.content = current.content + joiner + text;
        const previous = (current.info.extra as Record<string, unknown> | undefined)?.reasoning;
        if (reasoning) info.extra.reasoning = [previous, reasoning].filter(Boolean).join('\n');
        current.info = { ...current.info, ...info };
      }
      const updated = await api.updateMessage(
        message.id,
        {
          swipes,
          swipeId,
          extra: swipes[swipeId]!.info.extra as Record<string, unknown>,
          sendDate: info.send_date,
        },
        message.rev,
      );
      this.messages[index] = updated;
    }
    if (metadata && JSON.stringify(metadata) !== JSON.stringify($state.snapshot(chat.metadata))) {
      await this.updateMetadata(metadata).catch(() => {});
    }
  }

  async swipe(messageId: string, direction: -1 | 1) {
    if (this.generation || !this.chat) return;
    const index = this.messages.findIndex((m) => m.id === messageId);
    const message = this.messages[index];
    if (!message) return;
    const next = message.swipeId + direction;
    if (next < 0) return;
    if (next >= message.swipes.length) {
      const isLast = index === this.messages.length - 1;
      const hasUserBefore = this.messages.slice(0, index).some((m) => m.role === 'user');
      if (isLast && message.role === 'assistant' && hasUserBefore) await this.generate('swipe');
      return;
    }
    const extra = (message.swipes[next]!.info.extra as Record<string, unknown> | undefined) ?? message.extra;
    message.swipeId = next;
    try {
      this.messages[index] = await api.updateMessage(message.id, { swipeId: next, extra }, message.rev);
    } catch (error) {
      await this.#reloadMessages();
      ui.toast(errorText(error), 'error');
    }
  }

  async editMessage(messageId: string, text: string) {
    const index = this.messages.findIndex((m) => m.id === messageId);
    const message = this.messages[index];
    if (!message) return;
    const swipes = $state.snapshot(message.swipes);
    swipes[message.swipeId]!.content = text;
    this.messages[index] = await api.updateMessage(message.id, { swipes }, message.rev);
  }

  async toggleHidden(messageId: string) {
    const index = this.messages.findIndex((m) => m.id === messageId);
    const message = this.messages[index];
    if (!message) return;
    this.messages[index] = await api.updateMessage(message.id, { hidden: !message.hidden }, message.rev);
  }

  async deleteMessage(messageId: string) {
    if (!this.chat) return;
    await api.deleteMessages(this.chat.id, { ids: [messageId] });
    this.messages = this.messages.filter((m) => m.id !== messageId).map((m, seq) => ({ ...m, seq }));
  }

  async branch(index: number) {
    if (!this.chat) return;
    const chat = await api.branchChat(this.chat.id, index);
    this.chats.unshift(chat);
    await this.openChat(chat.id);
    ui.toast(t('chat.branched'));
  }

  // ---------------------------------------------------------------------------------------------
  // Jobs this tab did not start: replies that finished while no client was listening, and
  // generations running for this chat in another tab or on another device.

  #recovery: Promise<void> | null = null;
  #recoverAgain = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingReload = false;
  #reloadTimer: ReturnType<typeof setTimeout> | undefined;

  /** Picks up the open chat's jobs: running ones stream in live, finished ones are stored. */
  recoverJobs(): Promise<void> {
    if (this.#recovery) {
      this.#recoverAgain = true;
      return this.#recovery;
    }
    this.#recovery = (async () => {
      do {
        this.#recoverAgain = false;
        await this.#recoverOnce();
      } while (this.#recoverAgain);
    })().finally(() => {
      this.#recovery = null;
    });
    return this.#recovery;
  }

  async #recoverOnce() {
    const chat = this.chat;
    if (!chat || this.generation) return;
    let jobs: JobInfo[];
    try {
      jobs = await api.listJobs(chat.id);
    } catch {
      return;
    }
    for (const job of jobs) {
      if (this.chat?.id !== chat.id || this.generation) return;
      const meta = job.meta as unknown as Partial<JobMeta>;
      const provider = meta.providerId ? getProvider(meta.providerId) : undefined;
      if (!provider || !meta.target || job.status === 'aborted') {
        await api.ackJob(job.id).catch(() => {});
        continue;
      }
      if (job.status === 'failed') {
        // Report it once, unless the tab that started it is still around to do so.
        const claim = await api.claimJob(job.id).catch(() => null);
        if (claim?.claimed) {
          ui.toast(t('chat.generationFailed', { message: job.error ?? '' }), 'error');
          await api.ackJob(job.id).catch(() => {});
        } else if (claim && !claim.handled) {
          this.#retryRecovery();
        }
        continue;
      }
      const full = meta as JobMeta;
      const controller = new AbortController();
      this.generation = {
        type: full.type,
        target: full.target,
        jobId: job.id,
        text: '',
        reasoning: '',
        startedAt: Date.parse(full.startedAt) || Date.now(),
        controller,
      };
      try {
        const response = await api.resumeJob(job.id, 0, controller.signal);
        const stops = settings
          .get('chat', chatDefaults)
          .stoppingStrings.map((s) => macros.evaluate(s, { user: full.personaName, char: full.charName }));
        const stored = await this.#follow(job.id, response, full, provider, stops);
        if (stored && job.status === 'completed') ui.toast(t('chat.recovered'), 'success');
      } catch (error) {
        if (!controller.signal.aborted)
          ui.toast(t('chat.generationFailed', { message: errorText(error) }), 'error');
      } finally {
        this.generation = null;
        this.#afterGeneration();
      }
    }
  }

  #retryRecovery(delay = 16_000) {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => void this.recoverJobs(), delay);
  }

  #afterGeneration() {
    if (!this.#pendingReload) return;
    this.#pendingReload = false;
    void this.#reloadMessages().catch(() => {});
  }

  /** Reloads the open chat and picks up its jobs, after change events may have been missed. */
  async resync() {
    if (!this.chat) return;
    if (this.generation) this.#pendingReload = true;
    else await this.#reloadMessages().catch(() => {});
    await this.recoverJobs();
  }

  async onJobEvent(event: ChangeEvent) {
    if (!this.chat || event.chatId !== this.chat.id) return;
    // Follow a generation started elsewhere live.
    if (event.action === 'created') void this.recoverJobs();
    // Give the tab that started the job a moment to store it itself.
    else if (event.action === 'updated') setTimeout(() => void this.recoverJobs(), 2500);
  }

  async onRemoteChange(event: ChangeEvent) {
    if (!this.chat) return;
    if (event.kind === 'chat' && event.action === 'deleted' && event.id === this.chat.id) {
      this.chats = this.chats.filter((c) => c.id !== event.id);
      return;
    }
    const affectsChat =
      (event.kind === 'chat' && event.id === this.chat.id) ||
      (event.kind === 'message' && event.chatId === this.chat.id);
    if (!affectsChat) return;
    if (this.generation) {
      this.#pendingReload = true;
      return;
    }
    clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => void this.#reloadMessages().catch(() => {}), 300);
  }

  async #reloadMessages() {
    if (!this.chat) return;
    const [chat, messages] = await Promise.all([api.getChat(this.chat.id), api.messages(this.chat.id)]);
    this.chat = chat;
    this.messages = messages;
  }
}

export const chat = new ChatStore();
