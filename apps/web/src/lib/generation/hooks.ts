/**
 * Plugin hooks around a generation: change the messages a prompt is built from (SillyTavern's
 * generate interceptors) and the reply before it is stored.
 */

import type { Message } from '@bakatavern/api-client';

/** A message as hooks see it; `index` ties it to the stored message it came from. */
export interface HookMessage {
  index: number;
  name: string;
  role: 'user' | 'assistant' | 'system';
  hidden: boolean;
  text: string;
  extra: Record<string, unknown>;
}

export interface GenerationHooks {
  beforeBuild?(context: { type: string; messages: HookMessage[] }): void | Promise<void>;
  afterResponse?(text: string, context: { type: string }): string | void | Promise<string | void>;
}

const hooks = new Set<GenerationHooks>();

export function addGenerationHooks(set: GenerationHooks): () => void {
  hooks.add(set);
  return () => hooks.delete(set);
}

function hookMessage(message: Message, index: number): HookMessage {
  return {
    index,
    name: message.name,
    role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
    hidden: message.hidden,
    text: message.swipes[message.swipeId]?.content ?? '',
    extra: structuredClone(message.extra),
  };
}

/** The messages after every `beforeBuild` hook: changed ones rewritten, new ones made up. */
export async function messagesForPrompt(
  type: string,
  messages: readonly Message[],
): Promise<readonly Message[]> {
  const active = [...hooks].filter((h) => h.beforeBuild);
  if (!active.length) return messages;
  const list = messages.map(hookMessage);
  for (const set of active) {
    try {
      await set.beforeBuild!({ type, messages: list });
    } catch (error) {
      console.error('[plugins] a beforeBuild hook failed', error);
    }
  }
  const now = Date.now();
  return list.map((item, i) => {
    const original = Number.isInteger(item.index) ? messages[item.index] : undefined;
    const base: Message = original ?? {
      id: `hook-${i}`,
      chatId: messages[0]?.chatId ?? '',
      seq: i,
      role: item.role,
      name: item.name,
      characterId: null,
      hidden: false,
      swipeId: 0,
      swipes: [{ content: '', info: {} }],
      sendDate: new Date(now).toISOString(),
      extra: {},
      data: {},
      createdAt: now,
      updatedAt: now,
      rev: 0,
    };
    const swipes = base.swipes.map((s, j) => (j === base.swipeId ? { ...s, content: item.text } : s));
    return {
      ...base,
      seq: i,
      name: item.name,
      role: item.role,
      hidden: item.hidden,
      extra: item.extra,
      swipes,
    };
  });
}

/** The reply after every `afterResponse` hook. */
export async function replyAfterHooks(text: string, type: string): Promise<string> {
  let out = text;
  for (const set of hooks) {
    if (!set.afterResponse) continue;
    try {
      const result = await set.afterResponse(out, { type });
      if (typeof result === 'string') out = result;
    } catch (error) {
      console.error('[plugins] an afterResponse hook failed', error);
    }
  }
  return out;
}
