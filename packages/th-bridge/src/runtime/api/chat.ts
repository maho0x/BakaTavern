/**
 * TavernHelper's chat message functions (`function/chat_message.ts`, `displayed_message.ts`):
 * reads from the frame's copy, changes applied there and sent to the page as whole messages.
 */

import { Marked } from 'marked';

import type { MessageState } from '../../protocol.ts';
import type { Runtime } from '../context.ts';
import { currentText, swipeLists } from '../state.ts';

type Role = 'system' | 'assistant' | 'user';

interface GetOptions {
  role?: 'all' | Role;
  hide_state?: 'all' | 'hidden' | 'unhidden';
  include_swipes?: boolean;
}

interface Refresh {
  refresh?: 'none' | 'affected' | 'all';
}

type MessageUpdate = { message_id: number } & {
  name?: string;
  role?: Role;
  is_hidden?: boolean;
  message?: string;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  swipe_id?: number;
  swipes?: string[];
  swipes_data?: Record<string, unknown>[];
  swipes_info?: Record<string, unknown>[];
};

interface MessageCreating {
  name?: string;
  role: Role;
  is_hidden?: boolean;
  message: string;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

const marked = new Marked({ gfm: true, breaks: true, async: false });

export function chatApi(rt: Runtime) {
  const { mirror, transport } = rt;

  function getChatMessages(range: string | number, options: GetOptions = {}) {
    const { role = 'all', hide_state = 'all', include_swipes = false } = options;
    const parsed = mirror.range(rt.substitute(String(range)));
    if (!parsed) return [];
    const out: unknown[] = [];
    for (let id = parsed.start; id <= parsed.end; id++) {
      const message = mirror.messages[id];
      if (!message) continue;
      if (role !== 'all' && message.role !== role) continue;
      if (hide_state !== 'all' && (hide_state === 'hidden') !== message.is_hidden) continue;
      const lists = swipeLists(message);
      const base = { message_id: id, name: message.name, role: message.role, is_hidden: message.is_hidden };
      if (include_swipes) {
        out.push({ ...base, swipe_id: message.swipe_id, ...lists });
      } else {
        out.push({
          ...base,
          message: currentText(message),
          data: lists.swipes_data[message.swipe_id],
          extra: message.swipes_info.length ? lists.swipes_info[message.swipe_id] : message.extra,
          // for compatibility
          swipe_id: message.swipe_id,
          swipes: lists.swipes,
          swipes_data: lists.swipes_data,
        });
      }
    }
    return structuredClone(out);
  }

  /** Applies TavernHelper's update rules to a message (`setChatMessages`' `modify`). */
  function updated(message: MessageState, update: MessageUpdate): MessageState {
    const next = structuredClone(message);
    if (update.name !== undefined) next.name = update.name;
    if (update.role !== undefined) next.role = update.role;
    if (update.is_hidden !== undefined) next.is_hidden = update.is_hidden;
    const lists = swipeLists(next);
    if ('message' in update || 'data' in update) {
      if (update.message !== undefined) lists.swipes[next.swipe_id] = update.message;
      if (update.data !== undefined) lists.swipes_data[next.swipe_id] = update.data;
      if (update.extra !== undefined) {
        lists.swipes_info[next.swipe_id] = update.extra;
        next.extra = update.extra;
      }
      Object.assign(next, lists);
    } else if (
      update.swipe_id !== undefined ||
      update.swipes !== undefined ||
      update.swipes_data !== undefined ||
      update.swipes_info !== undefined
    ) {
      const length =
        Math.max(
          update.swipes?.length ?? 0,
          update.swipes_data?.length ?? 0,
          update.swipes_info?.length ?? 0,
        ) ||
        next.swipes.length ||
        1;
      const swipes = update.swipes ?? lists.swipes;
      const data = update.swipes_data ?? lists.swipes_data;
      const info = update.swipes_info ?? lists.swipes_info;
      next.swipe_id = Math.min(Math.max(update.swipe_id ?? next.swipe_id, 0), length - 1);
      next.swipes = Array.from({ length }, (_v, i) => swipes[i] ?? '');
      next.swipes_data = Array.from({ length }, (_v, i) => data[i] ?? {});
      next.swipes_info = Array.from({ length }, (_v, i) => info[i] ?? {});
    }
    return next;
  }

  async function setChatMessages(updates: MessageUpdate[], options: Refresh = {}) {
    const merged = new Map<number, MessageUpdate>();
    for (const update of updates) {
      const id = mirror.normalize(update.message_id);
      merged.set(id, { ...merged.get(id), ...update, message_id: id });
    }
    const changes: { index: number; message: MessageState }[] = [];
    for (const [index, update] of [...merged].sort((a, b) => a[0] - b[0])) {
      const message = mirror.messages[index];
      if (!message) continue;
      const next = updated(message, update);
      mirror.messages[index] = next;
      changes.push({ index, message: next });
    }
    if (changes.length) await transport.call('setMessages', changes, options.refresh ?? 'affected');
  }

  /** The old one-message form: `setChatMessage({message}, id, {swipe_id, refresh})`. */
  async function setChatMessage(
    fields: { message?: string; data?: Record<string, unknown> },
    messageId: number,
    options: {
      swipe_id?: 'current' | number;
      refresh?: 'none' | 'display_current' | 'display_and_render_current' | 'all';
    } = {},
  ) {
    const index = mirror.normalize(messageId);
    const message = mirror.messages[index];
    if (!message) return;
    const swipe =
      options.swipe_id === undefined || options.swipe_id === 'current' ? message.swipe_id : options.swipe_id;
    const lists = swipeLists(message);
    if (fields.message !== undefined) lists.swipes[swipe] = fields.message;
    if (fields.data !== undefined) lists.swipes_data[swipe] = fields.data;
    const next = { ...structuredClone(message), ...lists };
    mirror.messages[index] = next;
    await transport.call(
      'setMessages',
      [{ index, message: next }],
      options.refresh === 'none' ? 'none' : 'affected',
    );
  }

  async function createChatMessages(
    messages: MessageCreating[],
    options: { insert_at?: number | 'end'; insert_before?: number | 'end' } & Refresh = {},
  ) {
    const length = mirror.messages.length;
    const where = options.insert_at ?? options.insert_before ?? 'end';
    let before = where === 'end' ? length : Math.min(Math.max(where, -length), length);
    if (before < 0) before += length;
    const state = mirror.state;
    const created: MessageState[] = messages.map((m) => ({
      name:
        m.name ??
        (m.role === 'system'
          ? 'system'
          : m.role === 'user'
            ? state.user.name
            : (state.character?.name ?? '')),
      role: m.role,
      is_hidden: m.is_hidden ?? false,
      swipe_id: 0,
      swipes: [m.message],
      swipes_data: [m.data ?? {}],
      swipes_info: [],
      extra: m.extra ?? {},
      send_date: new Date().toISOString(),
    }));
    mirror.messages.splice(before, 0, ...created);
    await transport.call('createMessages', created, before, options.refresh ?? 'affected');
  }

  async function deleteChatMessages(ids: number[], options: Refresh = {}) {
    const length = mirror.messages.length;
    const indexes = [
      ...new Set(ids.filter((id) => id >= -length && id < length).map((id) => mirror.normalize(id))),
    ].sort((a, b) => a - b);
    if (!indexes.length) return;
    for (const index of [...indexes].reverse()) mirror.messages.splice(index, 1);
    await transport.call('deleteMessages', indexes, options.refresh ?? 'affected');
  }

  /** Moves `[begin, middle)` after `[middle, end)` (`rotateChatMessages`). */
  async function rotateChatMessages(begin: number, middle: number, end: number, options: Refresh = {}) {
    const [b, m, e] = [begin, middle, end].map((id) => mirror.normalize(id)) as [number, number, number];
    const slice = mirror.messages.slice(b, e);
    const rotated = [...slice.slice(m - b), ...slice.slice(0, m - b)];
    await setChatMessages(
      rotated.map((message, i) => ({
        message_id: b + i,
        name: message.name,
        role: message.role,
        is_hidden: message.is_hidden,
        swipe_id: message.swipe_id,
        swipes: message.swipes,
        swipes_data: message.swipes_data,
        swipes_info: message.swipes_info,
      })),
      options,
    );
  }

  /** Message text as the chat would show it (Markdown to HTML; no sanitizing inside the sandbox). */
  function formatAsDisplayedMessage(text: string, _options: { message_id?: number | 'last' } = {}) {
    return marked.parse(rt.substitute(text)) as string;
  }

  return {
    getChatMessages,
    setChatMessages,
    setChatMessage,
    createChatMessages,
    deleteChatMessages,
    rotateChatMessages,
    formatAsDisplayedMessage,
    retrieveDisplayedMessage: () => {
      throw new Error('retrieveDisplayedMessage is not available in safe mode');
    },
    refreshOneMessage: async (messageId: number) => {
      await transport.call('refreshMessage', mirror.normalize(messageId));
    },
  };
}
