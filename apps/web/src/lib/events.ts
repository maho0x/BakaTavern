/**
 * App events with SillyTavern's names (`event_types`), for plugins, front-end cards and scripts.
 * Listeners run one after another and are awaited, like SillyTavern's `eventSource.emit`.
 */

export const eventTypes = {
  APP_READY: 'app_ready',
  CHAT_CHANGED: 'chat_id_changed',
  CHAT_CREATED: 'chat_created',
  CHAT_DELETED: 'chat_deleted',
  GROUP_CHAT_CREATED: 'group_chat_created',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SWIPED: 'message_swiped',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  GENERATION_STARTED: 'generation_started',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  GROUP_WRAPPER_STARTED: 'group_wrapper_started',
  GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
  GROUP_MEMBER_DRAFTED: 'group_member_drafted',
  SETTINGS_UPDATED: 'settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_DELETED: 'characterDeleted',
  PERSONA_CHANGED: 'persona_changed',
  PRESET_CHANGED: 'preset_changed',
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
} as const;

type Listener = (...args: unknown[]) => unknown;

class EventBus {
  #listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): () => void {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return () => this.off(event, listener);
  }

  /** Runs before the listeners added with `on`. */
  makeFirst(event: string, listener: Listener): () => void {
    this.#listeners.set(event, [listener, ...(this.#listeners.get(event) ?? [])]);
    return () => this.off(event, listener);
  }

  once(event: string, listener: Listener): () => void {
    const off = this.on(event, (...args) => {
      off();
      return listener(...args);
    });
    return off;
  }

  off(event: string, listener: Listener) {
    const list = this.#listeners.get(event);
    if (list)
      this.#listeners.set(
        event,
        list.filter((l) => l !== listener),
      );
  }

  /** Calls every listener in turn; one that throws is reported and the others still run. */
  async emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        await listener(...args);
      } catch (error) {
        console.error(`[events] a "${event}" listener failed`, error);
      }
    }
  }
}

export const events = new EventBus();
