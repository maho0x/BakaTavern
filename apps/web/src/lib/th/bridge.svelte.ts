/**
 * Front-end cards in this app: what TavernHelper pages and scripts (sandboxed frames, see
 * `@bakatavern/th-bridge`) read and do — the chat, variables, lorebooks, slash commands and
 * generation.
 */

import type { Message, MessagePatch, NewMessage } from '@bakatavern/api-client';
import { ExtensionPromptPosition, ExtensionPromptRole, type ExtensionPrompt } from '@bakatavern/core';
import {
  BridgeHost,
  iframeEvents,
  type BridgeState,
  type Frame,
  type MessageState,
  type ScriptButton,
  type VariableTarget,
} from '@bakatavern/th-bridge';
import runtimeUrl from '@bakatavern/th-bridge/runtime.js?url';

import { api } from '../api.ts';
import { events, eventTypes } from '../events.ts';
import { generateQuiet, generateRaw, generateWithInput } from '../generation/background.svelte.ts';
import { addInjectionSource } from '../generation/injections.ts';
import { chat } from '../state/chat.svelte.ts';
import { library } from '../state/library.svelte.ts';
import { worldInfoDefaults } from '../state/prefs.ts';
import { cardScripts, regex } from '../state/regex.svelte.ts';
import { settings } from '../state/settings.svelte.ts';
import { ui } from '../state/ui.svelte.ts';
import { avatarKey } from '../stscript/lookup.ts';
import { scripts } from '../stscript/runtime.svelte.ts';
import { helperScripts, type ScriptSource } from './scripts.svelte.ts';

export { runtimeUrl };

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A stored message as TavernHelper sees it. */
export function messageState(message: Message): MessageState {
  const variables = (message.data as { variables?: unknown }).variables;
  const data = Array.isArray(variables)
    ? variables.map(obj)
    : variables && typeof variables === 'object'
      ? [obj(variables)]
      : [];
  const role = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant';
  return {
    name: message.name,
    role,
    is_hidden: message.hidden,
    swipe_id: message.swipeId,
    swipes: message.swipes.map((s) => s.content),
    swipes_data: data,
    // SillyTavern keeps swipe info on replies only.
    swipes_info: role === 'user' ? [] : message.swipes.map((s) => obj(s.info)),
    extra: obj(message.extra),
    send_date: message.sendDate,
  };
}

/** The change that makes a stored message match TavernHelper's version of it. */
export function messagePatch(current: Message, next: MessageState): MessagePatch {
  const extra = { ...next.extra };
  if (next.role === 'system') extra.type = 'narrator';
  else if (extra.type === 'narrator') delete extra.type;
  return {
    name: next.name,
    role: next.role,
    hidden: next.is_hidden,
    swipeId: Math.min(Math.max(next.swipe_id, 0), Math.max(next.swipes.length - 1, 0)),
    swipes: next.swipes.map((content, i) => ({
      content,
      info: next.swipes_info[i] ?? obj(current.swipes[i]?.info),
    })),
    extra,
    data: { ...obj(current.data), variables: next.swipes_data },
  };
}

interface Injection {
  prompt: ExtensionPrompt;
  once: boolean;
}

class FrontendBridge {
  readonly host: BridgeHost;
  /** Frames on screen; the state is only built and sent while there are some. */
  frames = $state(0);
  readonly #injections = new Map<string, Injection>();
  readonly #generations = new Map<string, AbortController>();
  readonly #saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.host = new BridgeHost({
      state: () => this.state(),
      call: (frame, method, args) => this.#call(frame, method, args),
      on: (event, listener) => events.on(event, listener),
      emit: (event, args) => events.emit(event, ...args),
      warn: (message) => console.warn('[front-end]', message),
    });
    addInjectionSource(() => {
      const out: Record<string, ExtensionPrompt> = {};
      for (const [id, injection] of this.#injections) {
        out[`th_inject_${id}`] = injection.prompt;
        if (injection.once) this.#injections.delete(id);
      }
      return out;
    });
  }

  /** Everything frames may read without waiting (reactive: an effect re-sends it on change). */
  state(): BridgeState {
    const character = chat.character;
    const card = obj(character?.card);
    const data = obj(card.data);
    const wi = settings.get('worldinfo', worldInfoDefaults);
    const persona = chat.persona;
    const thumb = (hash: string | null | undefined) => (hash ? api.thumbUrl(hash, 512) : '');
    const characterBooks = (id: string, cardData: Record<string, unknown>) => ({
      primary: String(obj(cardData.extensions).world ?? '') || null,
      additional: [...(wi.characterExtraBooks[id] ?? [])],
    });
    const helper = helperScripts.characterSettings;
    // A copy without reactive proxies: it is posted to frames.
    return $state.snapshot({
      chatId: chat.chat?.id ?? null,
      messages: chat.messages.map(messageState),
      variables: {
        global: obj($state.snapshot(settings.get('variables', {}))),
        chat: obj($state.snapshot(chat.chat?.metadata.variables)),
        character: character ? obj($state.snapshot(helper.variables)) : null,
        preset: obj($state.snapshot(helperScripts.preset?.settings.variables ?? {})),
      },
      user: { name: chat.userName, avatarUrl: thumb(persona?.avatar), persona: persona?.description ?? '' },
      character: character
        ? {
            name: character.name,
            avatar: avatarKey(character),
            avatarUrl: thumb(character.avatar),
            card: obj($state.snapshot(character.card)),
          }
        : null,
      group: chat.group ? { name: chat.group.name, members: chat.members.map((m) => m.name) } : null,
      characters: library.characters.map((c) => ({
        name: c.name,
        avatar: avatarKey(c),
        lorebooks:
          c.id === character?.id
            ? characterBooks(c.id, data)
            : { primary: null, additional: [...(wi.characterExtraBooks[c.id] ?? [])] },
      })),
      personas: library.personas.map((p) => p.name),
      lorebooks: {
        names: library.lorebooks.map((b) => b.name),
        global: [...wi.globalBooks],
        chat: (chat.chat?.metadata.world_info as string | undefined) || null,
        character: character ? characterBooks(character.id, data) : { primary: null, additional: [] },
      },
      regex: {
        global: $state.snapshot(regex.prefs.scripts),
        character: character ? cardScripts($state.snapshot(character.card)) : [],
        preset: $state.snapshot(regex.preset?.scripts ?? []),
        characterEnabled: !!character && regex.prefs.allowedCharacters.includes(character.id),
        presetEnabled: !!regex.preset && regex.prefs.allowedPresets.includes(regex.preset.id),
      },
      scripts: Object.fromEntries(
        helperScripts.running.map(({ script }) => [
          script.id,
          {
            name: script.name,
            data: obj($state.snapshot(script.data)),
            buttons: script.button.buttons.map((b) => ({ ...b })),
            info: script.info,
          },
        ]),
      ),
      generating: chat.busy,
    }) as BridgeState;
  }

  #stateTimer: ReturnType<typeof setTimeout> | undefined;

  /** Sends frames the state soon (changes often come in bursts), as it is then. */
  scheduleState() {
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      this.host.broadcastState();
    }, 30);
  }

  /** Prepares a frame (see `BridgeHost.open`); `close` when it goes. */
  open(info: Parameters<BridgeHost['open']>[0]) {
    const config = this.host.open(info, window.innerHeight);
    this.frames++;
    return config;
  }

  close(token: string) {
    this.host.close(token);
    this.frames = Math.max(0, this.frames - 1);
  }

  /** Where a script frame's script lives. */
  #scriptSource(id: string): ScriptSource | undefined {
    return helperScripts.running.find((r) => r.script.id === id)?.source;
  }

  /** Saves after a pause, once per key (frames may write many times in a row). */
  #later(key: string, save: () => Promise<void> | void) {
    clearTimeout(this.#saveTimers.get(key));
    this.#saveTimers.set(
      key,
      setTimeout(() => {
        this.#saveTimers.delete(key);
        void Promise.resolve(save()).catch((error: unknown) =>
          console.warn('[front-end] save failed', error),
        );
      }, 200),
    );
  }

  async #call(_frame: Frame, method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'replaceVariables':
        return this.#replaceVariables(obj(args[0]), args[1] as VariableTarget);
      case 'setMessages':
        return this.#setMessages(args[0] as { index: number; message: MessageState }[]);
      case 'createMessages':
        return this.#createMessages(args[0] as MessageState[], Number(args[1]));
      case 'deleteMessages': {
        const indexes = (args[0] as number[]).filter((i) => chat.messages[i]);
        for (const index of [...indexes].sort((a, b) => b - a)) await chat.deleteRange(index, index, false);
        return;
      }
      case 'refreshMessage':
      case 'reloadChat':
        return;
      case 'triggerSlash': {
        const result = await scripts.run(String(args[0] ?? ''));
        return result?.pipe ?? '';
      }
      case 'generate':
      case 'generateRaw':
        return this.#generate(method, obj(args[0]));
      case 'generateQuiet':
        return generateQuiet({ prompt: String(args[0] ?? '') });
      case 'stopGeneration': {
        const id = args[0] as string | null;
        for (const [key, controller] of this.#generations) if (!id || key === id) controller.abort();
        return;
      }
      case 'injectPrompts': {
        const prompts = args[0] as {
          id: string;
          position: string;
          depth: number;
          role: string;
          content: string;
          should_scan?: boolean;
        }[];
        const once = Boolean(obj(args[1]).once);
        const roles: Record<string, number> = {
          system: ExtensionPromptRole.SYSTEM,
          user: ExtensionPromptRole.USER,
          assistant: ExtensionPromptRole.ASSISTANT,
        };
        for (const p of prompts) {
          this.#injections.set(p.id, {
            once,
            prompt: {
              value: p.content,
              position:
                p.position === 'none' ? ExtensionPromptPosition.NONE : ExtensionPromptPosition.IN_CHAT,
              depth: Number(p.depth) || 0,
              role: roles[p.role] ?? ExtensionPromptRole.SYSTEM,
              scan: Boolean(p.should_scan),
            },
          });
        }
        return;
      }
      case 'uninjectPrompts':
        for (const id of args[0] as string[]) this.#injections.delete(id);
        return;
      case 'toast': {
        const [kind, message, title, options] = args as [string, string, string, { html?: boolean }];
        ui.toast(message, kind as 'info', { title: title || undefined, html: options?.html });
        return;
      }
      case 'getLorebook': {
        const info = library.lorebooks.find((b) => b.name === args[0]);
        return info ? (await api.getLorebook(info.id)).entries : null;
      }
      case 'replaceLorebook': {
        const info = library.lorebooks.find((b) => b.name === args[0]);
        if (!info) throw new Error(`未能找到世界书 '${String(args[0])}'`);
        const book = await api.getLorebook(info.id);
        await api.replaceLorebook(info.id, args[1] as Record<string, unknown>[], book.data, book.rev);
        await library.refreshLorebooks();
        await events.emit(eventTypes.WORLDINFO_UPDATED, book.name);
        return;
      }
      case 'createLorebook':
        await api.createLorebook(String(args[0]));
        await library.refreshLorebooks();
        return;
      case 'deleteLorebook': {
        const info = library.lorebooks.find((b) => b.name === args[0]);
        if (!info) return false;
        await api.deleteLorebook(info.id);
        await library.refreshLorebooks();
        return true;
      }
      case 'getOrCreateChatLorebook': {
        const bound = chat.chat?.metadata.world_info as string | undefined;
        if (bound && library.lorebooks.some((b) => b.name === bound)) return bound;
        const name = (args[0] as string | null) ?? `Chat Book ${chat.chat?.title ?? ''}`.trim();
        if (!library.lorebooks.some((b) => b.name === name)) {
          await api.createLorebook(name);
          await library.refreshLorebooks();
        }
        await chat.updateMetadata({ world_info: name });
        return name;
      }
      case 'bindLorebooks':
        return this.#bindLorebooks(String(args[0]), args[1], args[2] as string | undefined);
      case 'replaceScriptButtons': {
        const [id, buttons] = args as [string, ScriptButton[]];
        const source = this.#scriptSource(id);
        if (source) {
          await helperScripts.updateScript(source, id, (s) => ({ ...s, button: { ...s.button, buttons } }));
        }
        return;
      }
      case 'writeExtensionField': {
        const [key, value] = args as [string, unknown];
        await chat.updateCard((card) => {
          const data = (card.data ??= {});
          data.extensions = { ...(data.extensions as Record<string, unknown> | undefined), [key]: value };
        });
        return;
      }
      default:
        throw new Error(`${method} is not supported`);
    }
  }

  #replaceVariables(variables: Record<string, unknown>, target: VariableTarget) {
    switch (target.type) {
      case 'global':
        settings.replace('variables', variables);
        return;
      case 'chat':
        chat.setChatVariables(variables);
        return;
      case 'message': {
        const message = chat.messages[target.index];
        if (!message) return;
        const state = messageState(message);
        const data = Array.from(
          { length: Math.max(state.swipes.length, 1) },
          (_v, i) => state.swipes_data[i] ?? {},
        );
        data[state.swipe_id] = variables;
        message.data = { ...obj(message.data), variables: data };
        const id = message.id;
        this.#later(`message:${id}`, async () => {
          const i = chat.messages.findIndex((m) => m.id === id);
          const current = chat.messages[i];
          if (!current) return;
          chat.messages[i] = await api.updateMessage(
            id,
            { data: $state.snapshot(current.data) as Record<string, unknown> },
            current.rev,
          );
        });
        return;
      }
      case 'character': {
        const current = helperScripts.characterSettings;
        this.#later('character', () => helperScripts.setCharacterSettings({ ...current, variables }));
        return;
      }
      case 'preset': {
        const current = helperScripts.preset?.settings;
        if (current) this.#later('preset', () => helperScripts.setPresetSettings({ ...current, variables }));
        return;
      }
      case 'script': {
        const source = this.#scriptSource(target.script_id);
        if (source) {
          this.#later(`script:${target.script_id}`, () =>
            helperScripts.updateScript(source, target.script_id, (s) => ({ ...s, data: variables })),
          );
        }
        return;
      }
    }
  }

  async #setMessages(changes: { index: number; message: MessageState }[]) {
    for (const { index, message } of changes) {
      const current = chat.messages[index];
      if (!current) continue;
      chat.messages[index] = await api.updateMessage(current.id, messagePatch(current, message), current.rev);
      await events.emit(eventTypes.MESSAGE_UPDATED, index);
    }
  }

  async #createMessages(created: MessageState[], before: number) {
    const messages: NewMessage[] = created.map((m) => {
      const extra = { ...m.extra };
      if (m.role === 'system') extra.type = 'narrator';
      return {
        role: m.role,
        name: m.name,
        hidden: m.is_hidden,
        swipes: m.swipes.map((content) => ({ content, info: {} })),
        sendDate: m.send_date,
        extra,
        data: { variables: m.swipes_data },
      };
    });
    const at = before < chat.messages.length ? before : undefined;
    await chat.insertMessages(messages, at);
    for (let i = 0; i < created.length; i++) {
      const index = (at ?? chat.messages.length - created.length) + i;
      const user = created[i]!.role === 'user';
      await events.emit(user ? eventTypes.MESSAGE_SENT : eventTypes.MESSAGE_RECEIVED, index, 'extension');
      await events.emit(
        user ? eventTypes.USER_MESSAGE_RENDERED : eventTypes.CHARACTER_MESSAGE_RENDERED,
        index,
      );
    }
  }

  async #bindLorebooks(scope: string, value: unknown, characterName?: string) {
    const wi = settings.get('worldinfo', worldInfoDefaults);
    if (scope === 'global') {
      settings.update('worldinfo', { globalBooks: (value as string[]).filter(Boolean) });
    } else if (scope === 'chat') {
      await chat.updateMetadata({ world_info: (value as string) || undefined });
    } else if (scope === 'character') {
      const character = chat.character;
      const wanted = characterName && characterName !== 'current' ? characterName : null;
      if (!character || (wanted && wanted !== character.name && wanted !== avatarKey(character))) {
        throw new Error('Only the open character’s lorebooks can be changed');
      }
      const books = value as { primary: string | null; additional: string[] };
      await chat.updateCard((card) => {
        const data = (card.data ??= {});
        data.extensions = {
          ...(data.extensions as Record<string, unknown> | undefined),
          world: books.primary ?? '',
        };
      });
      settings.update('worldinfo', {
        characterExtraBooks: { ...wi.characterExtraBooks, [character.id]: [...books.additional] },
      });
    }
  }

  async #generate(kind: 'generate' | 'generateRaw', config: Record<string, unknown>) {
    const id = String(config.generation_id ?? '');
    const controller = new AbortController();
    this.#generations.set(id, controller);
    const userInput = String(config.user_input ?? config.prompt ?? '');
    try {
      await events.emit(iframeEvents.GENERATION_STARTED, id);
      let text: string;
      let reasoning = '';
      if (kind === 'generateRaw') {
        text = await generateRaw({ prompt: rawPrompt(config, userInput), signal: controller.signal });
      } else {
        const result = await generateWithInput({
          input: userInput,
          maxHistory: typeof config.max_chat_history === 'number' ? config.max_chat_history : undefined,
          signal: controller.signal,
        });
        text = result.text;
        reasoning = result.reasoning;
      }
      await events.emit(iframeEvents.STREAM_TOKEN_RECEIVED_FULLY, text, id);
      await events.emit(iframeEvents.GENERATION_ENDED, text, id);
      return config.should_return_reasoning ? { content: text, reasoning } : text;
    } finally {
      this.#generations.delete(id);
    }
  }
}

/**
 * TavernHelper's `generateRaw` prompt: its own messages and the user input in the given order
 * (`ordered_prompts`); other built-in parts are left out.
 */
function rawPrompt(config: Record<string, unknown>, userInput: string) {
  const ordered = Array.isArray(config.ordered_prompts) ? config.ordered_prompts : ['user_input'];
  const out: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
  for (const item of ordered) {
    if (item === 'user_input') {
      if (userInput) out.push({ role: 'user', content: userInput });
    } else if (item && typeof item === 'object') {
      const p = item as { role?: string; content?: unknown };
      const role = p.role === 'user' || p.role === 'assistant' ? p.role : 'system';
      out.push({ role, content: String(p.content ?? '') });
    }
  }
  return out;
}

export const bridge = new FrontendBridge();

/** Whether the open character's pages run unsandboxed (trust mode). */
export function trusted(): boolean {
  const id = chat.characterId;
  return !!id && helperScripts.prefs.trustedCharacters.includes(id);
}
