import type {
  ChangeEvent,
  Character,
  Chat,
  Group,
  JobInfo,
  Message,
  NewMessage,
  Persona,
  Swipe,
} from '@bakatavern/api-client';
import { ApiError, randomId } from '@bakatavern/api-client';
import {
  toolInvocationsText,
  type ModelToolCall,
  branchChatTitle,
  cardData,
  getRegexedString,
  greetingSwipes,
  normalizeGroupSettings,
  extractMessageBias,
  groupMacroNames,
  objectVariables,
  RegexPlacement,
  removeMacros,
  selectSpeakers,
  type VariableScope,
  type GroupMember,
  type GroupPromptContext,
  type SpeakerOptions,
  type GenerationOutput,
  type GenerationType,
  type MacroEnv,
  type ProviderAdapter,
  type RegexParams,
  type RegexSubstitute,
} from '@bakatavern/core';

import { api } from '../api.ts';
import { events, eventTypes } from '../events.ts';
import { replyAfterHooks } from '../generation/hooks.ts';
import { offeredTools, runToolCalls } from '../generation/tools.ts';
import {
  attachmentKind,
  isTextFile,
  uploadAttachments,
  type PendingAttachment,
} from '../generation/attachments.ts';
import {
  activeConnection,
  activeFormatting,
  finalizeOutput,
  itemizeGeneration,
  macros,
  newAssistantMessage,
  prepare,
  readResponse,
  responseAdapter,
  swipeInfo,
  type JobMeta,
  type Target,
} from '../generation/pipeline.ts';
import { t } from '../i18n/index.svelte.ts';
import { library } from './library.svelte.ts';
import { flushPendingSaves } from './pending-saves.ts';
import { chatDefaults, noteDefaults, personaDefaults } from './prefs.ts';
import { regex } from './regex.svelte.ts';
import { settings } from './settings.svelte.ts';
import { globalVariables } from './variables.ts';
import { errorText, ui } from './ui.svelte.ts';

export interface Generation {
  type: GenerationType;
  target: Target;
  jobId: string | null;
  text: string;
  reasoning: string;
  startedAt: number;
  controller: AbortController;
  /** The result is stored: stop showing the streamed copy (cleanup requests may still run). */
  stored?: boolean;
  /** Tool rounds before this generation, and whether tools were offered with it. */
  toolDepth?: number;
  toolsOffered?: boolean;
  /** Called tools were run: generate again with their results. */
  continueWithTools?: boolean;
  /** The member replying in a group chat. */
  speaker?: { id: string; name: string; avatar: string | null };
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

/** Who writes system messages (SillyTavern's `systemUserName`). */
export const SYSTEM_NAME = 'SillyTavern System';

/** SillyTavern-style chat file name: `Name - 2026-10-14@23h56m12s`. */
function chatTitle(name: string, date = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${name} - ${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}@${p(date.getHours())}h${p(date.getMinutes())}m${p(date.getSeconds())}s`;
}

/** SillyTavern's group chat file name (`humanizedDateTime`): `2026-10-14@23h56m12s345ms`. */
function groupChatTitle(date = new Date()) {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}@${p(date.getHours())}h${p(date.getMinutes())}m${p(date.getSeconds())}s${p(date.getMilliseconds(), 3)}ms`;
}

/** Generation types a group member is asked for (the round itself may be `regenerate` or `auto`). */
type GroupRoundType = SpeakerOptions['type'];

function activeText(message: Message) {
  return message.swipes[message.swipeId]?.content ?? '';
}

class ChatStore {
  characterId = $state<string | null>(null);
  character = $state<Character | null>(null);
  /** A group chat is open instead of a character's. */
  groupId = $state<string | null>(null);
  group = $state<Group | null>(null);
  /** The group's member characters (with their cards), in group order. */
  members = $state<Character[]>([]);
  /** Members keep talking among themselves (SillyTavern's auto mode). */
  autoMode = $state(false);
  /** A round of group replies is running (between members no generation is). */
  groupRunning = $state(false);
  chats = $state<Chat[]>([]);
  chat = $state<Chat | null>(null);
  messages = $state<Message[]>([]);
  recent = $state<Chat[]>([]);
  loading = $state(false);
  generation = $state<Generation | null>(null);
  draft = $state('');

  /**
   * A persona chosen by a script (`/persona-set`) for the rest of the session: it wins over the
   * character's lock in the chat it was chosen in (SillyTavern selects it right away), elsewhere
   * the locks come first.
   */
  selectedPersona = $state<{ id: string; chatId: string | null } | null>(null);
  /** A name used without a persona (`/persona-set mode=temp`), until a persona is chosen. */
  tempUserName = $state<string | null>(null);

  /**
   * The reply whose `MESSAGE_RECEIVED` listeners are running: its pages wait for them, as
   * SillyTavern renders a message after that event (scripts update its variables first).
   */
  receiving = $state<string | null>(null);

  async #received(index: number, type: string) {
    try {
      await events.emit(eventTypes.MESSAGE_RECEIVED, index, type);
    } finally {
      this.receiving = null;
    }
    await events.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, index, type);
  }

  /** Persona in use: chat lock, character (or group) lock, default, then the first persona. */
  persona = $derived.by((): Persona | undefined => {
    const prefs = settings.get('persona', personaDefaults);
    const locked = this.chat?.metadata.persona as string | undefined;
    const owner = this.groupId ?? this.characterId;
    const selected = this.selectedPersona;
    const chosenHere = selected && selected.chatId === (this.chat?.id ?? null) ? selected.id : null;
    return (
      library.persona(locked) ??
      library.personas.find((p) => locked && p.sourceFile === locked) ??
      library.persona(chosenHere) ??
      library.persona(owner ? prefs.characterPersona[owner] : null) ??
      library.persona(selected?.id) ??
      library.persona(prefs.defaultPersonaId) ??
      library.personas.find((p) => p.isDefault) ??
      library.personas[0]
    );
  });

  userName = $derived(this.tempUserName ?? this.persona?.name ?? 'User');

  /** Uses a persona from now on (SillyTavern `autoSelectPersona`); a chat lock follows it. */
  async selectPersona(persona: Persona) {
    this.tempUserName = null;
    this.selectedPersona = { id: persona.id, chatId: this.chat?.id ?? null };
    if (this.chat?.metadata.persona) await this.updateMetadata({ persona: persona.id });
  }

  /** A generation, or a round of group replies, is running. */
  get busy() {
    return Boolean(this.generation) || this.groupRunning;
  }

  /** Regex scripts in effect for this chat (global, preset, character). */
  regexScripts = $derived(regex.scriptsFor(this.character));

  /** Depth of every visible message (0 = the last one), for regex depth limits. */
  regexDepths = $derived.by(() => {
    const visible = this.messages.filter((m) => !m.hidden);
    return new Map(visible.map((m, i) => [m.id, visible.length - i - 1]));
  });

  /** Macros for regex scripts outside of generation (variables are read from copies). */
  regexSubstitute(): RegexSubstitute {
    const card = (this.character?.card as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    const env: MacroEnv = {
      user: this.userName,
      char: this.character?.name ?? '',
      description: String(card.description ?? ''),
      personality: String(card.personality ?? ''),
      scenario: String(card.scenario ?? ''),
      persona: this.persona?.description ?? '',
      chatId: this.chat?.id,
      localVariables: objectVariables({
        ...($state.snapshot(this.chat?.metadata.variables) as Record<string, unknown> | undefined),
      }),
      globalVariables: objectVariables({ ...(settings.get('variables', {}) as Record<string, unknown>) }),
    };
    return (text, options) =>
      macros.evaluate(text, {
        ...env,
        ...(options?.charName !== undefined ? { char: options.charName } : {}),
        postProcess: options?.postProcess,
      });
  }

  /**
   * The chat's variables (SillyTavern `chat_metadata.variables`), saved shortly after a change.
   * Scripts and macros outside of generation write through this.
   */
  chatVariables(): VariableScope {
    const read = () => (this.chat?.metadata.variables ?? {}) as Record<string, unknown>;
    const write = (next: Record<string, unknown>) => {
      if (!this.chat) return;
      this.chat.metadata.variables = next;
      clearTimeout(this.#variablesTimer);
      this.#variablesTimer = setTimeout(() => void this.flushVariables(), 300);
    };
    return {
      get: (name) => read()[name],
      set: (name, value) => write({ ...read(), [name]: value }),
      has: (name) => Object.hasOwn(read(), name),
      delete: (name) => {
        const next = { ...read() };
        delete next[name];
        write(next);
      },
      entries: () => Object.entries(read()),
    };
  }

  #variablesTimer: ReturnType<typeof setTimeout> | undefined;

  /** Replaces all of the chat's variables (saved shortly after, like single changes). */
  setChatVariables(next: Record<string, unknown>) {
    if (!this.chat) return;
    this.chat.metadata.variables = next;
    clearTimeout(this.#variablesTimer);
    this.#variablesTimer = setTimeout(() => void this.flushVariables(), 300);
  }

  /** Saves changed chat variables now. */
  async flushVariables() {
    clearTimeout(this.#variablesTimer);
    this.#variablesTimer = undefined;
    if (!this.chat) return;
    const variables = $state.snapshot(this.chat.metadata.variables ?? {}) as Record<string, unknown>;
    await this.updateMetadata({ variables }).catch((error) => ui.toast(errorText(error), 'error'));
  }

  /**
   * Keeps what a generation's macros (`{{setvar}}`, `{{setglobalvar}}` ...) wrote into its copies of
   * the variables: global ones always, the chat's when `chat` is given (otherwise they are saved
   * with the reply's metadata).
   */
  async keepGenerationVariables(globals: Record<string, unknown>, chat?: Record<string, unknown>) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
    if (!same(globals, settings.get('variables', {}))) settings.replace('variables', globals);
    if (chat && this.chat && !same(chat, $state.snapshot(this.chat.metadata.variables))) {
      this.chat.metadata.variables = chat;
      await this.flushVariables();
    }
  }

  /**
   * Macros for the open chat outside of generation (scripts, Quick Replies, sent messages). In a
   * group no member is `{{char}}`.
   */
  macroEnv(): MacroEnv {
    const card = cardData($state.snapshot(this.character?.card) ?? {});
    const meta = (this.chat?.metadata ?? {}) as Record<string, unknown>;
    const members = this.group
      ? groupMacroNames(
          this.members.map((m) => ({
            id: m.id,
            name: m.name,
            card: null,
            muted: this.group!.members.find((x) => x.characterId === m.id)?.muted ?? false,
          })),
          '',
        )
      : {};
    return {
      user: this.userName,
      char: this.character?.name ?? '',
      description: card.description,
      personality: card.personality,
      scenario: String(meta.scenario || card.scenario),
      persona: this.persona?.description ?? '',
      mesExamplesRaw: String(meta.mes_example || card.mes_example),
      charPrompt: String(meta.system_prompt || card.system_prompt),
      charInstruction: card.post_history_instructions,
      charDepthPrompt: card.extensions.depth_prompt?.prompt ?? '',
      creatorNotes: card.creator_notes,
      charVersion: card.character_version,
      firstMessage: card.first_mes,
      alternateGreetings: card.alternate_greetings,
      input: this.draft,
      messages: this.messages.map((m) => ({
        name: m.name,
        role: m.role as 'user' | 'assistant' | 'system',
        hidden: m.hidden,
        text: activeText(m),
        swipeId: m.swipeId,
        swipeCount: m.swipes.length,
      })),
      localVariables: this.chatVariables(),
      globalVariables: globalVariables(),
      chatId: this.chat?.id,
      ...members,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Changes scripts make (SillyTavern's slash commands)

  /**
   * A system message (SillyTavern `sendSystemMessage`): kept out of the prompt, shown small.
   * `extra.bias` records a "start reply with".
   */
  async addSystemMessage(text: string, extra: Record<string, unknown> = {}) {
    await this.insertMessages([
      {
        role: 'assistant',
        name: SYSTEM_NAME,
        hidden: true,
        swipes: [{ content: text, info: {} }],
        sendDate: new Date().toISOString(),
        extra: { swipeable: false, isSmallSys: true, ...extra },
      },
    ]);
  }

  /** Adds messages at an index (the end when missing or out of range). */
  async insertMessages(messages: NewMessage[], at?: number): Promise<Message[]> {
    const chat = this.chat;
    if (!chat) throw new Error(t('script.noChat'));
    const inside = at !== undefined && !Number.isNaN(at) && at >= 0 && at < this.messages.length;
    const added = await api.addMessages(chat.id, messages, inside ? at : undefined);
    if (inside) await this.#reloadMessages();
    else this.messages.push(...added);
    return added;
  }

  /** Hides (or shows) the messages from `start` to `end`, optionally only those named `name`. */
  async setHiddenRange(start: number, end: number, hidden: boolean, name = '') {
    for (let i = start; i <= end; i++) {
      const message = this.messages[i];
      if (!message || (name && message.name !== name) || message.hidden === hidden) continue;
      this.messages[i] = await api.updateMessage(message.id, { hidden }, message.rev);
    }
  }

  /**
   * Deletes the messages from `start` to `end` with the hidden tool call records before them
   * (SillyTavern `deleteMessage`). Returns their text, one per line.
   */
  async deleteRange(start: number, end: number, withToolCalls = true): Promise<string> {
    const chat = this.chat;
    if (!chat) return '';
    const ids: string[] = [];
    let text = '';
    for (let i = start; i <= end; i++) {
      const message = this.messages[i];
      if (!message) continue;
      text += `${activeText(message)}\n`;
      ids.push(message.id);
      if (withToolCalls && message.role !== 'user' && !message.hidden) {
        for (let j = i - 1; j >= 0; j--) {
          const previous = this.messages[j]!;
          if (!previous.hidden || !Array.isArray(previous.extra.tool_invocations)) break;
          if (!ids.includes(previous.id)) ids.push(previous.id);
        }
      }
    }
    if (ids.length) {
      await api.deleteMessages(chat.id, { ids });
      this.messages = this.messages.filter((m) => !ids.includes(m.id)).map((m, seq) => ({ ...m, seq }));
      await events.emit(eventTypes.MESSAGE_DELETED, this.messages.length);
    }
    return text;
  }

  /** Adds a swipe to the last reply; returns its index. */
  async addSwipe(text: string, switchTo: boolean): Promise<number> {
    const index = this.messages.length - 1;
    const message = this.messages[index];
    if (!message) throw new Error(t('script.noMessages'));
    if (message.role === 'user') throw new Error(t('script.swipeUser'));
    if (message.hidden) throw new Error(t('script.swipeHidden'));
    const swipes = $state.snapshot(message.swipes) as Swipe[];
    const now = new Date().toISOString();
    swipes.push({
      content: text,
      info: {
        send_date: now,
        gen_started: null,
        gen_finished: null,
        extra: {
          bias: await extractMessageBias(text),
          gen_id: Date.now(),
          api: 'manual',
          model: 'slash command',
        },
      },
    });
    const swipeId = switchTo ? swipes.length - 1 : message.swipeId;
    this.messages[index] = await api.updateMessage(message.id, { swipes, swipeId }, message.rev);
    return swipes.length - 1;
  }

  /** Deletes a swipe of the last message (its current one by default); returns the swipe shown. */
  async deleteSwipe(swipeIndex: number | null): Promise<number | null> {
    const index = this.messages.length - 1;
    const message = this.messages[index];
    if (!message || message.swipes.length === 0) throw new Error(t('script.noMessages'));
    if (message.swipes.length <= 1) throw new Error(t('script.lastSwipe'));
    const current = Math.min(Math.max(message.swipeId, 0), message.swipes.length - 1);
    const target = swipeIndex ?? current;
    if (!Number.isInteger(target) || target < 0 || target >= message.swipes.length)
      throw new Error(t('script.badSwipe', { id: target + 1 }));
    const swipes = ($state.snapshot(message.swipes) as Swipe[]).filter((_, i) => i !== target);
    const swipeId =
      target < current ? current - 1 : target > current ? current : Math.min(target, swipes.length - 1);
    const extra = (swipes[swipeId]!.info.extra as Record<string, unknown> | undefined) ?? message.extra;
    this.messages[index] = await api.updateMessage(message.id, { swipes, swipeId, extra }, message.rev);
    return swipeId;
  }

  /** Changes a message's role (`system` makes it a narrator message). */
  async setMessageRole(index: number, role: 'user' | 'assistant' | 'system') {
    const message = this.messages[index];
    if (!message) return;
    const extra = { ...($state.snapshot(message.extra) as Record<string, unknown>) };
    if (role === 'system') extra.type = 'narrator';
    else delete extra.type;
    this.messages[index] = await api.updateMessage(message.id, { role, extra }, message.rev);
  }

  async updateMessageFields(index: number, patch: Parameters<typeof api.updateMessage>[1]) {
    const message = this.messages[index];
    if (!message) return;
    this.messages[index] = await api.updateMessage(message.id, patch, message.rev);
  }

  /** Runs this chat's regex scripts for a placement. */
  applyRegex(text: string, placement: number, params: RegexParams = {}): string {
    const scripts = this.regexScripts;
    if (!scripts.length || !text) return text;
    return getRegexedString(text, placement, scripts, this.regexSubstitute(), params);
  }

  async restoreLast() {
    const groupId = store.get('bt.lastGroup');
    if (groupId && library.group(groupId)) return this.openGroup(groupId, store.get('bt.lastChat'));
    const characterId = store.get('bt.lastCharacter');
    if (characterId && library.character(characterId))
      await this.openCharacter(characterId, store.get('bt.lastChat'));
  }

  /** Back to the welcome screen (going home, or the open group or character is gone). */
  close() {
    this.stopAutoMode();
    this.characterId = null;
    this.character = null;
    this.groupId = null;
    this.group = null;
    this.members = [];
    this.chats = [];
    this.chat = null;
    this.messages = [];
  }

  async openCharacter(id: string, preferChatId?: string | null) {
    if (this.busy) return;
    this.loading = true;
    try {
      const [character, chats] = await Promise.all([api.getCharacter(id), api.listChats(id)]);
      this.#leaveGroup();
      this.characterId = id;
      this.character = character;
      regex.checkCharacter(character);
      this.chats = chats;
      store.set('bt.lastCharacter', id);
      store.set('bt.lastGroup', '');
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

  #leaveGroup() {
    this.stopAutoMode();
    this.groupId = null;
    this.group = null;
    this.members = [];
  }

  /** Opens a group chat: its most recent chat, or a new one with the members' greetings. */
  async openGroup(id: string, preferChatId?: string | null) {
    if (this.busy) return;
    this.loading = true;
    try {
      const [group, chats] = await Promise.all([api.getGroup(id), api.listGroupChats(id)]);
      const members = await this.#loadMembers(group);
      this.#leaveGroup();
      this.characterId = null;
      this.character = null;
      this.groupId = id;
      this.group = group;
      this.members = members;
      this.chats = chats;
      store.set('bt.lastGroup', id);
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

  async #loadMembers(group: Group): Promise<Character[]> {
    const loaded = await Promise.all(
      group.members.map((m) => api.getCharacter(m.characterId).catch(() => null)),
    );
    return loaded.filter((c): c is Character => c !== null);
  }

  /** Picks up changes to the open group (members, settings) and to its members' cards. */
  async reloadGroup() {
    if (!this.groupId) return;
    const group = await api.getGroup(this.groupId);
    this.group = group;
    this.members = await this.#loadMembers(group);
    library.upsertGroup(group);
  }

  /** Changes the open group's members or settings (retried once when it changed elsewhere). */
  async updateGroup(patch: Parameters<typeof api.updateGroup>[1]) {
    const id = this.groupId;
    if (!id) return;
    for (let attempt = 0; ; attempt++) {
      const current = attempt ? await api.getGroup(id) : this.group!;
      try {
        const updated = await api.updateGroup(id, patch, current.rev);
        library.upsertGroup(updated);
        if (this.groupId === id) {
          this.group = updated;
          if (patch.members) this.members = await this.#loadMembers(updated);
        }
        return;
      } catch (error) {
        if (attempt > 0 || !(error instanceof ApiError && error.code === 'conflict')) throw error;
      }
    }
  }

  /** Mutes or unmutes a member (muted members reply only when asked to). */
  async setMuted(characterId: string, muted: boolean) {
    const members = this.group?.members.map((m) => (m.characterId === characterId ? { ...m, muted } : m));
    if (members) await this.updateGroup({ members });
  }

  /** The group's members for speaker selection and prompts. */
  #groupMembers(): GroupMember[] {
    const muted = new Map(this.group?.members.map((m) => [m.characterId, m.muted]));
    return this.members.map((c) => ({
      id: c.id,
      name: c.name,
      card: $state.snapshot(c.card),
      muted: muted.get(c.id) ?? false,
    }));
  }

  async reloadCharacter() {
    if (this.characterId) this.character = await api.getCharacter(this.characterId);
  }

  /**
   * Changes the open character's card, starting from its latest stored version (retried once
   * when it changed elsewhere meanwhile).
   */
  async updateCard(mutate: (card: Record<string, unknown> & { data?: Record<string, unknown> }) => void) {
    const id = this.character?.id;
    if (!id) return;
    for (let attempt = 0; ; attempt++) {
      const current = await api.getCharacter(id);
      const card = structuredClone(current.card) as Record<string, unknown> & {
        data?: Record<string, unknown>;
      };
      mutate(card);
      try {
        const updated = await api.updateCharacter(id, card, current.rev);
        if (this.character?.id === id) this.character = updated;
        library.upsertCharacter(updated);
        return;
      } catch (error) {
        if (attempt > 0 || !(error instanceof ApiError && error.code === 'conflict')) throw error;
      }
    }
  }

  async openChat(id: string) {
    const [chat, messages] = await Promise.all([api.getChat(id), api.messages(id)]);
    this.chat = chat;
    this.messages = messages;
    store.set('bt.lastChat', id);
    void this.recoverJobs();
    await events.emit(eventTypes.CHAT_CHANGED, id);
  }

  async newChat() {
    if (this.group) return this.#newGroupChat(this.group);
    const character = this.character;
    if (!character) return;
    const card = $state.snapshot(character.card);
    const name = character.name;
    const greetings = greetingSwipes(card, macros, { user: this.userName, char: name }, (text) =>
      this.applyRegex(text, RegexPlacement.AI_OUTPUT),
    );
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
    await events.emit(eventTypes.CHAT_CREATED);
    await events.emit(eventTypes.CHAT_CHANGED, created.chat.id);
  }

  /** A new group chat starts with every member's greeting (SillyTavern picks one at random). */
  async #newGroupChat(group: Group) {
    const now = new Date().toISOString();
    const greetings: NewMessage[] = [];
    for (const member of this.members) {
      const card = cardData($state.snapshot(member.card));
      const options = [card.first_mes, ...card.alternate_greetings].filter((g) => g);
      const text = options[Math.floor(Math.random() * options.length)];
      if (!text) continue;
      greetings.push({
        role: 'assistant',
        name: member.name,
        characterId: member.id,
        swipes: [
          { content: macros.evaluate(text.trim(), { user: this.userName, char: member.name }), info: {} },
        ],
        sendDate: now,
        extra: { gen_id: Date.now() * Math.random() * 1000000 },
      });
    }
    const created = await api.createChat({ groupId: group.id, title: groupChatTitle(), messages: greetings });
    this.chats.unshift(created.chat);
    this.chat = created.chat;
    this.messages = created.messages;
    store.set('bt.lastChat', created.chat.id);
    await events.emit(eventTypes.GROUP_CHAT_CREATED);
    await events.emit(eventTypes.CHAT_CHANGED, created.chat.id);
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

  /** Files attached to the next message. */
  attachments = $state<PendingAttachment[]>([]);

  attach(files: Iterable<File>) {
    for (const file of files) {
      const kind = attachmentKind(file);
      if (kind === 'file' && !isTextFile(file)) {
        ui.toast(t('chat.attachUnsupported', { name: file.name }), 'error');
        continue;
      }
      this.attachments.push({
        id: randomId(),
        file,
        kind,
        preview: kind === 'image' ? URL.createObjectURL(file) : undefined,
      });
    }
  }

  detach(id: string) {
    const item = this.attachments.find((a) => a.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.attachments = this.attachments.filter((a) => a.id !== id);
  }

  /** Sends a message and asks for replies; in a group, `forced` names the member who answers. */
  async send(text: string, forced?: string) {
    if (this.busy || !this.chat) return;
    // In a group, who replies depends on the message and the chat before it.
    const speakers = this.group ? this.#speakers('normal', text, forced) : null;
    const pending = $state.snapshot(this.attachments) as PendingAttachment[];
    if (text.trim() || pending.length) {
      // `{{bias "..."}}` starts the reply; a message of nothing else only records it, hidden
      // (SillyTavern `getBiasStrings`).
      const bias = await extractMessageBias(text);
      if (bias && !removeMacros(text) && !pending.length) {
        await this.addSystemMessage(' ', { bias });
      } else {
        // Macros are expanded when the message is sent (SillyTavern `sendMessageAsUser`).
        let content = macros.evaluate(this.applyRegex(text, RegexPlacement.USER_INPUT), this.macroEnv());
        if (bias) content = removeMacros(content);
        const extra: Record<string, unknown> = pending.length ? await uploadAttachments(pending) : {};
        if (bias) extra.bias = bias;
        const [message] = await api.addMessages(this.chat.id, [
          {
            role: 'user',
            name: this.userName,
            swipes: [{ content, info: {} }],
            sendDate: new Date().toISOString(),
            extra,
          },
        ]);
        this.messages.push(message!);
        const index = this.messages.length - 1;
        await events.emit(eventTypes.MESSAGE_SENT, index);
        await events.emit(eventTypes.USER_MESSAGE_RENDERED, index);
      }
      this.draft = '';
      for (const item of pending) this.detach(item.id);
    }
    if (speakers) await this.#runGroup('normal', speakers);
    else await this.generate('normal');
  }

  async regenerate() {
    if (this.busy || !this.chat) return;
    if (this.group) {
      // The last round of replies goes (SillyTavern `regenerateGroup`).
      const last = this.messages.at(-1);
      const round = last && last.role !== 'user' && !last.hidden ? last.extra.gen_id : undefined;
      const ids: string[] = [];
      for (const message of [...this.messages].reverse()) {
        const id = message.extra.gen_id;
        if (round && id && round !== id) break;
        if (message.role === 'user' || message.hidden) break;
        ids.push(message.id);
      }
      if (ids.length) {
        await api.deleteMessages(this.chat.id, { ids });
        this.messages = this.messages.filter((m) => !ids.includes(m.id)).map((m, seq) => ({ ...m, seq }));
      }
      return this.#runGroup('regenerate', this.#speakers('regenerate', ''));
    }
    const last = this.messages.at(-1);
    if (last?.role === 'assistant' && this.messages.length > 1) {
      await api.deleteMessages(this.chat.id, { ids: [last.id] });
      this.messages.pop();
    }
    await this.generate('regenerate');
  }

  async generate(type: GenerationType, toolDepth = 0) {
    if (this.group) {
      if (this.busy) return;
      const speakers = this.#speakers(type, '');
      if (!speakers.length && (type === 'swipe' || type === 'continue'))
        ui.toast(t('group.noSpeaker'), 'error');
      return this.#runGroup(type, speakers);
    }
    const character = this.character;
    if (character) await this.#generateAs(type, character, toolDepth);
  }

  /** Another character answers once in this one's chat (SillyTavern `/ask`). */
  async askCharacter(characterId: string): Promise<Message | null> {
    if (this.group) throw new Error(t('script.askGroup'));
    const character = await api.getCharacter(characterId);
    const before = this.messages.length;
    const ok = await this.#generateAs('normal', character, 0, undefined, true);
    return ok && this.messages.length > before ? (this.messages.at(-1) ?? null) : null;
  }

  /** Asks one member for a reply now, with the message in the box if there is one. */
  async trigger(characterId: string) {
    if (this.busy) return;
    if (this.draft.trim() || this.attachments.length) return this.send(this.draft, characterId);
    await this.#runGroup('normal', this.#speakers('normal', '', characterId));
  }

  /** The members who reply (SillyTavern's activation strategies). */
  #speakers(type: GroupRoundType, input: string, forced?: string): string[] {
    if (!this.group) return [];
    return selectSpeakers({
      type,
      settings: normalizeGroupSettings(this.group.settings),
      members: this.#groupMembers(),
      messages: this.messages.map((m) => ({
        name: m.name,
        role: m.role as 'user' | 'assistant' | 'system',
        hidden: m.hidden,
        characterId: m.characterId,
        narrator: (m.extra as { type?: unknown }).type === 'narrator',
        text: activeText(m),
      })),
      input,
      forced,
    });
  }

  #groupStopped = false;

  /** One reply from each member in turn; Stop ends the round. */
  async #runGroup(type: GroupRoundType, speakerIds: readonly string[]) {
    if (!speakerIds.length || this.groupRunning) return;
    this.groupRunning = true;
    this.#groupStopped = false;
    // Replies of one round share an id, like SillyTavern's `gen_id`.
    const roundId = Date.now();
    const memberType: GenerationType =
      type === 'swipe' || type === 'continue' || type === 'impersonate' || type === 'quiet' ? type : 'normal';
    const groupId = this.groupId;
    await events.emit(eventTypes.GROUP_WRAPPER_STARTED, { selected_group: groupId, type });
    try {
      for (const id of speakerIds) {
        const speaker = this.members.find((c) => c.id === id);
        if (!speaker) continue;
        await events.emit(eventTypes.GROUP_MEMBER_DRAFTED, id);
        const ok = await this.#generateAs(memberType, speaker, 0, roundId);
        if (!ok || this.#groupStopped || !this.group) break;
      }
    } finally {
      this.groupRunning = false;
      await events.emit(eventTypes.GROUP_WRAPPER_FINISHED, { selected_group: groupId, type });
    }
  }

  /** Who speaks for the group outside of a round (quiet generations: the last speaker). */
  groupSpeaker(type: GroupRoundType): string | undefined {
    return this.#speakers(type, '')[0];
  }

  groupContext(speaker: Character): GroupPromptContext {
    const settings = normalizeGroupSettings(this.group!.settings);
    return {
      members: this.#groupMembers(),
      speakerId: speaker.id,
      generationMode: settings.generation_mode,
      joinPrefix: settings.generation_mode_join_prefix,
      joinSuffix: settings.generation_mode_join_suffix,
    };
  }

  #autoTimer: ReturnType<typeof setInterval> | undefined;

  /** Auto mode: members reply on their own every few seconds while nobody is typing. */
  setAutoMode(on: boolean) {
    clearInterval(this.#autoTimer);
    this.autoMode = on && Boolean(this.group);
    if (!this.autoMode) return;
    const delay = normalizeGroupSettings(this.group!.settings).auto_mode_delay;
    this.#autoTimer = setInterval(() => void this.#autoTick(), Math.max(1, delay) * 1000);
  }

  stopAutoMode() {
    this.setAutoMode(false);
  }

  async #autoTick() {
    if (!this.group || !this.chat || this.busy || this.draft.trim()) return;
    await this.#runGroup('auto', this.#speakers('auto', ''));
  }

  /**
   * Generates a reply from `character` (in a group, one member). Returns whether it went through
   * (not stopped, no error).
   */
  async #generateAs(
    type: GenerationType,
    character: Character,
    toolDepth = 0,
    roundId?: number,
    /** `/ask`: another character answers in this chat (its reply shows its avatar). */
    asked = false,
  ): Promise<boolean> {
    const chat = this.chat;
    if (this.generation || !chat) return false;
    const connection = activeConnection();
    if (!connection) {
      ui.toast(t('chat.noConnection'), 'error');
      ui.panel = 'connection';
      return false;
    }
    const inGroup = Boolean(this.group);
    const last = this.messages.at(-1);
    let target: Target;
    if (type === 'swipe' && last) target = { kind: 'swipe', messageId: last.id };
    else if (type === 'continue' && last) target = { kind: 'continue', messageId: last.id };
    else if (type === 'impersonate') target = { kind: 'impersonate' };
    else target = { kind: 'new' };

    // The job id is ours from the start, so Stop works even before the provider answers.
    const jobId = randomId();
    const controller = new AbortController();
    const generation: Generation = {
      type,
      target,
      jobId,
      text: '',
      reasoning: '',
      startedAt: Date.now(),
      controller,
      toolDepth,
      speaker: inGroup ? { id: character.id, name: character.name, avatar: character.avatar } : undefined,
    };
    this.generation = generation;
    const metadata = $state.snapshot(chat.metadata) as Record<string, unknown>;
    const globals = $state.snapshot(settings.get('variables', {})) as Record<string, unknown>;
    let failed: boolean;
    await events.emit(eventTypes.GENERATION_STARTED, type, {}, false);
    try {
      await events.emit(eventTypes.GENERATION_AFTER_COMMANDS, type, {}, false);
      // Edits saved after a short delay (presets, personas, entries) count from the moment they are made.
      await flushPendingSaves();
      const prepared = await prepare(
        {
          type,
          character: $state.snapshot(character) as Character,
          persona: this.persona,
          userName: this.userName,
          chat,
          metadata,
          globalVariables: globals,
          messages: $state.snapshot(this.messages) as Message[],
          // A group member's own regex scripts apply to its reply.
          regexScripts: $state.snapshot(regex.scriptsFor(character)),
          tools: connection.api === 'chat' ? await offeredTools() : undefined,
          toolDepth,
          group: inGroup ? this.groupContext(character) : undefined,
        },
        connection,
      );
      await this.keepGenerationVariables(globals);
      if (prepared.worldInfo.activated.length)
        await events.emit(eventTypes.WORLD_INFO_ACTIVATED, prepared.worldInfo.activated);
      this.generation.toolsOffered = prepared.api === 'chat' && Boolean(prepared.request.tools?.length);
      if (prepared.api === 'chat' && prepared.prompt.error === 'budget')
        throw new Error(t('chat.budgetExceeded'));
      const meta: JobMeta = {
        type,
        target,
        api: connection.api,
        providerId: connection.api === 'text' ? connection.type.id : connection.provider.id,
        model: prepared.model,
        stream: prepared.stream,
        stoppingStrings: prepared.stoppingStrings,
        charName: character.name,
        personaName: this.userName,
        startedAt: new Date().toISOString(),
        continuedText: type === 'continue' && last ? activeText(last) : undefined,
        ...(inGroup
          ? { characterId: character.id, groupGenId: roundId, groupNames: this.members.map((m) => m.name) }
          : {}),
        ...(asked
          ? { characterId: character.id, forceAvatar: character.sourceFile ?? `${character.name}.png` }
          : {}),
      };
      // What was sent, for the prompt viewer (counted in the background).
      void itemizeGeneration(prepared)
        ?.then((data) =>
          api.putPrompt(chat.id, {
            startedAt: meta.startedAt,
            data: data as unknown as Record<string, unknown>,
          }),
        )
        .catch(() => {});
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
      failed = !(await this.#follow(
        jobId,
        started.response,
        meta,
        responseAdapter(meta)!,
        prepared.stoppingStrings,
        metadata,
      ));
    } catch (error) {
      failed = true;
      if (!controller.signal.aborted)
        ui.toast(t('chat.generationFailed', { message: errorText(error) }), 'error');
    } finally {
      // (Read through the state: its proxy keeps its own copy of the fields.)
      generation.continueWithTools = this.generation?.continueWithTools;
      this.generation = null;
      this.#afterGeneration();
    }
    if (controller.signal.aborted) {
      await events.emit(eventTypes.GENERATION_STOPPED);
      return false;
    }
    await events.emit(eventTypes.GENERATION_ENDED, this.messages.length);
    // The model called tools: answer with their results (SillyTavern generates again).
    if (generation.continueWithTools)
      return this.#generateAs('normal', character, toolDepth + 1, roundId, asked);
    return !failed;
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
    adapter: Pick<ProviderAdapter, 'createDecoder' | 'parseResponse'>,
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
        adapter,
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
    this.#groupStopped = true;
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
    // A group member's reply goes through its own regex scripts.
    const member = meta.characterId ? this.members.find((m) => m.id === meta.characterId) : undefined;
    const memberScripts = member ? regex.scriptsFor(member) : null;
    const finalized = finalizeOutput(output, meta, stoppingStrings, (raw, placement) =>
      memberScripts
        ? raw && memberScripts.length
          ? getRegexedString(raw, placement, memberScripts, this.regexSubstitute(), {
              characterOverride: meta.charName,
            })
          : raw
        : this.applyRegex(raw, placement),
    );
    const reasoning = finalized.reasoning;
    // Plugins may change the reply before it is stored.
    const text =
      meta.type === 'impersonate' ? finalized.text : await replyAfterHooks(finalized.text, meta.type);
    const target = meta.target;
    // Tool calls are run only by the tab that asked for them.
    const toolCalls = this.generation?.toolsOffered && output.toolCalls?.length ? output.toolCalls : null;
    const emptyToolReply =
      Boolean(toolCalls) && target.kind !== 'swipe' && ['', '...'].includes(text) && !reasoning;
    if (target.kind === 'impersonate') {
      this.draft = text;
    } else if (target.kind === 'new') {
      if (emptyToolReply) {
        // Nothing but tool calls: no reply message.
      } else if (!text && !reasoning) {
        ui.toast(t('chat.emptyReply'));
      } else {
        const [message] = await api.addMessages(chat.id, [newAssistantMessage(meta, text, reasoning)]);
        this.receiving = message!.id;
        this.messages.push(message!);
        if (this.generation) this.generation.stored = true;
        const index = this.messages.length - 1;
        await this.#received(index, meta.type);
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
      this.receiving = updated.id;
      this.messages[index] = updated;
      if (this.generation) this.generation.stored = true;
      await this.#received(index, meta.type);
    }
    if (metadata && JSON.stringify(metadata) !== JSON.stringify($state.snapshot(chat.metadata))) {
      await this.updateMetadata(metadata).catch(() => {});
    }
    if (toolCalls) await this.#runTools(meta, toolCalls, reasoning, emptyToolReply);
  }

  /**
   * Runs the tools a reply called and records the calls in the chat (SillyTavern's hidden "Tool
   * calls" message); the generation then continues with their results.
   */
  async #runTools(meta: JobMeta, calls: readonly ModelToolCall[], reasoning: string, emptyReply: boolean) {
    const chat = this.chat;
    const generation = this.generation;
    if (!chat || !generation) return;
    const result = await runToolCalls(calls, reasoning, (note) => ui.toast(note));
    if (result.errors.length) {
      ui.toast(
        t('chat.toolErrors', { list: result.errors.map((e) => `${e.cause}: ${e.message}`).join('; ') }),
        'error',
      );
    }
    if ((!result.invocations.length && emptyReply) || result.stealthCalls.length) return;
    if (result.invocations.length) {
      const [message] = await api.addMessages(chat.id, [
        {
          role: 'assistant',
          name: 'System',
          hidden: true,
          swipes: [{ content: toolInvocationsText(result.invocations), info: {} }],
          sendDate: new Date().toISOString(),
          extra: {
            isSmallSys: true,
            tool_invocations: result.invocations,
            api: meta.providerId,
            model: meta.model,
          },
        },
      ]);
      this.messages.push(message!);
    }
    generation.continueWithTools = true;
  }

  async swipe(messageId: string, direction: -1 | 1) {
    if (this.busy || !this.chat) return;
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
      await events.emit(eventTypes.MESSAGE_SWIPED, index);
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
    const narrator = (message.extra as { type?: string }).type === 'narrator';
    const placement =
      message.role === 'user'
        ? RegexPlacement.USER_INPUT
        : narrator
          ? RegexPlacement.SLASH_COMMAND
          : RegexPlacement.AI_OUTPUT;
    swipes[message.swipeId]!.content = this.applyRegex(text, placement, {
      characterOverride: narrator ? undefined : message.name,
      isEdit: true,
    });
    this.messages[index] = await api.updateMessage(message.id, { swipes }, message.rev);
    await events.emit(eventTypes.MESSAGE_EDITED, index);
    await events.emit(eventTypes.MESSAGE_UPDATED, index);
  }

  /** Shows another image of a message's gallery (SillyTavern `extra.media_index`). */
  async setMediaIndex(messageId: string, index: number) {
    const i = this.messages.findIndex((m) => m.id === messageId);
    const message = this.messages[i];
    if (!message) return;
    const extra = { ...($state.snapshot(message.extra) as Record<string, unknown>), media_index: index };
    this.messages[i] = await api.updateMessage(message.id, { extra }, message.rev);
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
    await events.emit(eventTypes.MESSAGE_DELETED, this.messages.length);
  }

  /** Copies the chat up to a message into a new chat and opens it (SillyTavern's branches). */
  async branch(index: number) {
    if (!this.chat) return;
    const { chat, message } = await api.branchChat(this.chat.id, {
      upTo: index,
      title: branchChatTitle(this.chat.title, 'branch', (title) => this.chats.some((c) => c.title === title)),
    });
    this.#replaceMessage(message);
    this.chats.unshift(chat);
    await this.openChat(chat.id);
    ui.toast(t('chat.branched'));
  }

  /** The name SillyTavern suggests for a new checkpoint of this chat. */
  checkpointTitle(): string {
    return branchChatTitle(this.chat?.title ?? '', 'checkpoint', (title) =>
      this.chats.some((c) => c.title === title),
    );
  }

  /**
   * Saves the chat up to a message as a checkpoint: a copy the message links to (its flag), while
   * this chat stays open.
   */
  async checkpoint(index: number, title: string) {
    if (!this.chat) return;
    const { chat, message } = await api.branchChat(this.chat.id, { upTo: index, checkpoint: true, title });
    this.#replaceMessage(message);
    this.chats.unshift(chat);
    ui.toast(t('chat.checkpointCreated', { name: chat.title }), 'success');
  }

  /** Opens a chat of this character by its name (checkpoint links, the main chat). */
  async openChatByTitle(title: string) {
    const target = this.chats.find((c) => c.title === title);
    if (!target) throw new Error(t('chat.chatMissing', { name: title }));
    await this.openChat(target.id);
  }

  #replaceMessage(message: Message) {
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) this.messages[index] = message;
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
    if (!chat || this.busy) return;
    let jobs: JobInfo[];
    try {
      jobs = await api.listJobs(chat.id);
    } catch {
      return;
    }
    for (const job of jobs) {
      if (this.chat?.id !== chat.id || this.generation) return;
      const meta = job.meta as unknown as Partial<JobMeta>;
      const adapter = meta.providerId
        ? responseAdapter({ api: meta.api, providerId: meta.providerId })
        : undefined;
      if (!adapter || !meta.target || job.status === 'aborted') {
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
      const member = full.characterId ? this.members.find((m) => m.id === full.characterId) : undefined;
      this.generation = {
        speaker: member ? { id: member.id, name: member.name, avatar: member.avatar } : undefined,
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
        // Replies are cleaned up with the current formatting templates.
        await activeFormatting().catch(() => {});
        const stops =
          full.stoppingStrings ??
          settings
            .get('chat', chatDefaults)
            .stoppingStrings.map((s) => macros.evaluate(s, { user: full.personaName, char: full.charName }));
        const stored = await this.#follow(job.id, response, full, adapter, stops);
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
