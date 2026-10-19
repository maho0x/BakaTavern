/**
 * What frames find as `SillyTavern` (the subset of `getContext()` cards commonly use) and as
 * `toastr`. Data comes from the frame's copy of the chat; actions go to the page.
 */

import { tavernEvents } from '../../events.ts';
import type { MessageState } from '../../protocol.ts';
import type { Runtime } from '../context.ts';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export function toastrShim(rt: Runtime) {
  const show =
    (kind: ToastKind) => (message?: unknown, title?: unknown, options?: { escapeHtml?: boolean }) => {
      rt.transport.notify('toast', kind, String(message ?? ''), title === undefined ? '' : String(title), {
        html: options?.escapeHtml === false,
      });
      return { remove: () => {} };
    };
  return {
    success: show('success'),
    info: show('info'),
    warning: show('warning'),
    error: show('error'),
    clear: () => {},
    remove: () => {},
    options: {},
  };
}

/** A message as SillyTavern keeps it in `chat`. */
function stMessage(message: MessageState) {
  return {
    name: message.name,
    is_user: message.role === 'user',
    is_system: message.is_hidden,
    send_date: message.send_date,
    mes: message.swipes[message.swipe_id] ?? '',
    swipe_id: message.swipe_id,
    swipes: [...message.swipes],
    swipe_info: structuredClone(message.swipes_info),
    variables: structuredClone(message.swipes_data),
    extra: structuredClone(
      message.role === 'system' ? { ...message.extra, type: 'narrator' } : message.extra,
    ),
  };
}

export function sillyTavernApi(rt: Runtime, functions: Record<string, unknown>) {
  const { mirror, events, transport } = rt;
  const eventSource = {
    on: (event: string, listener: (...args: unknown[]) => unknown) => events.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => unknown) => events.once(event, listener),
    makeFirst: (event: string, listener: (...args: unknown[]) => unknown) =>
      events.makeFirst(event, listener),
    makeLast: (event: string, listener: (...args: unknown[]) => unknown) => events.makeLast(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => unknown) =>
      events.remove(event, listener),
    emit: (event: string, ...args: unknown[]) => events.emit(event, args),
  };

  const getContext = () => {
    const state = mirror.state;
    return {
      chat: state.messages.map(stMessage),
      chatId: state.chatId,
      getCurrentChatId: () => state.chatId,
      name1: state.user.name,
      name2: state.character?.name ?? '',
      characterId: state.character
        ? state.characters.findIndex((c) => c.avatar === state.character!.avatar)
        : undefined,
      characters: state.characters.map((c) => ({ name: c.name, avatar: c.avatar })),
      groupId: state.group ? state.group.name : null,
      chatMetadata: { variables: structuredClone(state.variables.chat) },
      extensionSettings: { variables: { global: structuredClone(state.variables.global) } },
      eventSource,
      event_types: tavernEvents,
      eventTypes: tavernEvents,
      substituteParams: (text: string) => rt.substitute(text),
      substituteParamsExtended: (text: string) => rt.substitute(text),
      executeSlashCommands: (command: string) =>
        transport.call<string>('triggerSlash', command).then((pipe) => ({ pipe })),
      executeSlashCommandsWithOptions: (command: string) =>
        transport.call<string>('triggerSlash', command).then((pipe) => ({ pipe })),
      generateQuietPrompt: (prompt: string | { quietPrompt?: string }) =>
        transport.call<string>(
          'generateQuiet',
          typeof prompt === 'string' ? prompt : (prompt?.quietPrompt ?? ''),
        ),
      generateRaw: (options: string | Record<string, unknown>) =>
        (functions.generateRaw as (config: unknown) => Promise<unknown>)(
          typeof options === 'string' ? { user_input: options } : options,
        ),
      saveChat: async () => {},
      saveMetadata: async () => {},
      reloadCurrentChat: () => transport.call('reloadChat'),
      getRequestHeaders: () => ({}),
      // `writeExtensionField` (`_th_impl`): data on the current card's extensions.
      writeExtensionField: (_id: unknown, key: string, value: unknown) =>
        transport.call('writeExtensionField', key, value),
    };
  };

  return { ...getContext(), getContext };
}
