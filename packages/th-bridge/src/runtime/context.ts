/** What every group of TavernHelper functions works with inside a frame. */

import { createMacroEngine, objectVariables, type MacroEnv } from '@bakatavern/core/macros/index';

import type { FrameEvents } from './events.ts';
import type { Mirror } from './state.ts';
import type { Transport } from './transport.ts';

export interface Runtime {
  mirror: Mirror;
  transport: Transport;
  events: FrameEvents;
  /** SillyTavern's macros over the frame's copy of the chat (`substituteParamsExtended`). */
  substitute(text: string): string;
}

const engine = createMacroEngine();

export function macroSubstitute(mirror: Mirror, onVariables: (type: 'chat' | 'global') => void) {
  return (text: string): string => {
    const state = mirror.state;
    const card = ((state.character?.card as { data?: Record<string, unknown> } | undefined)?.data ??
      {}) as Record<string, unknown>;
    const text_ = (value: unknown) => (typeof value === 'string' ? value : '');
    const chat = state.variables.chat;
    const global = state.variables.global;
    const before = JSON.stringify([chat, global]);
    const env: MacroEnv = {
      user: state.user.name,
      char: state.character?.name ?? '',
      group: state.group?.members.join(', '),
      isGroup: Boolean(state.group),
      description: text_(card.description),
      personality: text_(card.personality),
      scenario: text_(card.scenario),
      persona: state.user.persona,
      creatorNotes: text_(card.creator_notes),
      firstMessage: text_(card.first_mes),
      messages: state.messages.map((m) => ({
        name: m.name,
        role: m.role,
        hidden: m.is_hidden,
        text: m.swipes[m.swipe_id] ?? '',
        swipeId: m.swipe_id,
        swipeCount: m.swipes.length,
      })),
      localVariables: objectVariables(chat),
      globalVariables: objectVariables(global),
      chatId: state.chatId ?? undefined,
    };
    const result = engine.evaluate(text, env);
    const [chatBefore, globalBefore] = JSON.parse(before) as [unknown, unknown];
    if (JSON.stringify(chat) !== JSON.stringify(chatBefore)) onVariables('chat');
    if (JSON.stringify(global) !== JSON.stringify(globalBefore)) onVariables('global');
    return result;
  };
}
