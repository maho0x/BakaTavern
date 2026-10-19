/**
 * Group chats (SillyTavern `group-chats.js`): who speaks next, and the parts of the prompt that
 * depend on the group (joined character cards, every member's depth prompt, trimmed replies).
 */

import { cardData, type CardData } from '../model/card.ts';
import type { Rng } from '../util/random.ts';

/** How members are picked to reply (SillyTavern `group_activation_strategy`). */
export const GroupActivation = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const;

/** Whose card goes into the prompt (SillyTavern `group_generation_mode`). */
export const GroupGenerationMode = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const;

export const DEFAULT_AUTO_MODE_DELAY = 5;
export const TALKATIVENESS_DEFAULT = 0.5;

/** A group's settings, with SillyTavern's keys (the group file without its members and chats). */
export interface GroupSettings {
  activation_strategy: number;
  generation_mode: number;
  generation_mode_join_prefix: string;
  generation_mode_join_suffix: string;
  allow_self_responses: boolean;
  auto_mode_delay: number;
  hideMutedSprites: boolean;
  [extra: string]: unknown;
}

export const groupSettingsDefaults: GroupSettings = {
  activation_strategy: GroupActivation.NATURAL,
  generation_mode: GroupGenerationMode.SWAP,
  generation_mode_join_prefix: '',
  generation_mode_join_suffix: '',
  allow_self_responses: false,
  auto_mode_delay: DEFAULT_AUTO_MODE_DELAY,
  hideMutedSprites: false,
};

export function normalizeGroupSettings(data: unknown): GroupSettings {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback;
  return {
    ...raw,
    activation_strategy: num(raw.activation_strategy, GroupActivation.NATURAL),
    generation_mode: num(raw.generation_mode, GroupGenerationMode.SWAP),
    generation_mode_join_prefix: String(raw.generation_mode_join_prefix ?? ''),
    generation_mode_join_suffix: String(raw.generation_mode_join_suffix ?? ''),
    allow_self_responses: Boolean(raw.allow_self_responses),
    auto_mode_delay: num(raw.auto_mode_delay, DEFAULT_AUTO_MODE_DELAY),
    hideMutedSprites: Boolean(raw.hideMutedSprites),
  };
}

export interface GroupMember {
  /** The member's character id. */
  id: string;
  name: string;
  card: unknown;
  /** Muted members don't reply on their own (SillyTavern `disabled_members`). */
  muted: boolean;
}

/** A chat message as speaker selection sees it. */
export interface GroupChatMessage {
  name: string;
  role: 'user' | 'assistant' | 'system';
  /** Kept out of the prompt (SillyTavern `is_system`). */
  hidden: boolean;
  /** The member who wrote it (SillyTavern `original_avatar`). */
  characterId?: string | null;
  /** `extra.type === 'narrator'`. */
  narrator?: boolean;
  /** Active swipe text (names mentioned in the last message activate members). */
  text: string;
}

/** How likely a member is to reply on its own in natural order (0–1). */
export function talkativeness(card: unknown): number {
  const raw = cardData(card).extensions.talkativeness ?? (card as { talkativeness?: unknown })?.talkativeness;
  const value = Number(raw);
  return raw === undefined || raw === '' || Number.isNaN(value) ? TALKATIVENESS_DEFAULT : value;
}

/** Lowercased words of a text (SillyTavern `extractAllWords`). */
export function extractAllWords(value: string): string[] {
  return value ? [...value.matchAll(/\b\w+\b/gim)].map((m) => m[0].toLowerCase()) : [];
}

function shuffle<T>(items: T[], random: Rng): T[] {
  for (let i = items.length; i !== 0;) {
    const j = Math.floor(random() * i);
    i--;
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

const unique = <T>(items: readonly T[]) => items.filter((x, i) => items.indexOf(x) === i);

/** Names in CJK scripts have no word boundaries: they count as mentioned when they appear at all. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

export interface SpeakerOptions {
  /** `normal` (a message was sent or the reply was asked for), `auto` (auto mode), or a generation type. */
  type: 'normal' | 'auto' | 'regenerate' | 'swipe' | 'continue' | 'impersonate' | 'quiet';
  settings: Pick<GroupSettings, 'activation_strategy' | 'allow_self_responses'>;
  /** Every member in group order, muted ones too. */
  members: readonly GroupMember[];
  /** The chat before the user's new message. */
  messages: readonly GroupChatMessage[];
  /** What the user sent (empty when the reply was asked for without a message). */
  input?: string;
  /** This member replies, whatever the strategy (`/trigger`, the member list's button). */
  forced?: string;
  random?: Rng;
}

/**
 * The members who reply, in order (SillyTavern `generateGroupWrapper`). Empty when nobody does:
 * the user's message is then just sent (manual mode, everyone muted).
 */
export function selectSpeakers(options: SpeakerOptions): string[] {
  const random = options.random ?? Math.random;
  const { members, messages, type } = options;
  if (!members.length) return [];
  if (options.forced) return members.some((m) => m.id === options.forced) ? [options.forced] : [];
  const ids = members.map((m) => m.id);
  const enabled = members.filter((m) => !m.muted);
  const lastMessage = messages.at(-1);
  const isUserInput = Boolean(options.input) && type !== 'auto';
  const activationText = isUserInput
    ? options.input!
    : lastMessage && !lastMessage.hidden
      ? lastMessage.text
      : '';

  if (type === 'quiet') {
    const swiped = lastSpeaker(members, messages, true, random).slice(0, 1);
    return swiped.length ? swiped : ids.slice(0, 1);
  }
  if (type === 'swipe' || type === 'continue') return lastSpeaker(members, messages, false, random);
  if (type === 'impersonate') return [ids[Math.floor(random() * ids.length)]!];

  switch (Number(options.settings.activation_strategy)) {
    case GroupActivation.LIST:
      return unique(enabled.map((m) => m.id));
    case GroupActivation.POOLED:
      return pooledOrder(enabled, messages, isUserInput, random);
    case GroupActivation.MANUAL:
      return isUserInput
        ? []
        : shuffle([...enabled], random)
            .slice(0, 1)
            .map((m) => m.id);
    default:
      return naturalOrder(
        enabled,
        activationText,
        lastMessage,
        options.settings.allow_self_responses,
        isUserInput,
        random,
      );
  }
}

function isSpeaker(message: GroupChatMessage, allowSystem: boolean) {
  return !(message.role === 'user' || (!allowSystem && message.hidden) || message.narrator);
}

/** The member who wrote the last reply (SillyTavern `activateSwipe`). */
function lastSpeaker(
  members: readonly GroupMember[],
  messages: readonly GroupChatMessage[],
  allowSystem: boolean,
  random: Rng,
) {
  const last = messages.at(-1);
  if (!last) return [];
  const found: string[] = [];
  if (!isSpeaker(last, allowSystem)) {
    const previous = [...messages].reverse().find((m) => isSpeaker(m, allowSystem) && m.characterId);
    if (previous?.characterId) found.push(previous.characterId);
    else if (members.length) found.push(members[Math.floor(random() * members.length)]!.id);
  }
  if (last.characterId) found.push(last.characterId);
  else {
    // Messages from before members were recorded: by name.
    const byName = members.find((m) => m.name === last.name);
    if (byName) found.push(byName.id);
  }
  return found.filter((id) => members.some((m) => m.id === id));
}

/** One member who hasn't spoken since the user did (SillyTavern `activatePooledOrder`). */
function pooledOrder(
  members: readonly GroupMember[],
  messages: readonly GroupChatMessage[],
  isUserInput: boolean,
  random: Rng,
): string[] {
  const spoken: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role === 'user' || isUserInput) break;
    if (message.hidden || message.narrator) continue;
    if (message.characterId) spoken.push(message.characterId);
  }
  const notSpoken = members.filter((m) => !spoken.includes(m.id));
  let chosen: GroupMember | undefined;
  if (notSpoken.length) chosen = notSpoken[Math.floor(random() * notSpoken.length)];
  if (!chosen) {
    const last = messages.at(-1);
    const lastId = members.length > 1 && last && last.role !== 'user' ? last.characterId : undefined;
    const pool = lastId ? members.filter((m) => m.id !== lastId) : members;
    chosen = pool[Math.floor(random() * pool.length)];
  }
  return chosen ? [chosen.id] : [];
}

/**
 * Members mentioned by name, then members who feel like talking, or one at random
 * (SillyTavern `activateNaturalOrder`).
 */
function naturalOrder(
  members: readonly GroupMember[],
  input: string,
  lastMessage: GroupChatMessage | undefined,
  allowSelfResponses: boolean,
  isUserInput: boolean,
  random: Rng,
): string[] {
  // The last speaker doesn't reply to itself, unless allowed.
  const banned =
    !allowSelfResponses && !isUserInput && lastMessage && lastMessage.role !== 'user'
      ? lastMessage.name
      : undefined;
  const activated: string[] = [];
  if (input) {
    for (const word of extractAllWords(input)) {
      const member = members.find((m) => m.name !== banned && extractAllWords(m.name).includes(word));
      if (member) activated.push(member.id);
    }
    const mentioned = members
      .filter((m) => m.name !== banned && NO_SPACES.test(m.name) && input.includes(m.name))
      .sort((a, b) => input.indexOf(a.name) - input.indexOf(b.name));
    activated.push(...mentioned.map((m) => m.id));
  }
  const chatty: GroupMember[] = [];
  for (const member of shuffle([...members], random)) {
    if (member.name === banned) continue;
    const chance = talkativeness(member.card);
    if (chance >= random()) activated.push(member.id);
    if (chance > 0) chatty.push(member);
  }
  const pool = chatty.length ? chatty : members;
  for (let retries = 0; activated.length === 0 && ++retries <= pool.length;) {
    activated.push(pool[Math.floor(random() * pool.length)]!.id);
  }
  return unique(activated);
}

/** Group settings and members as prompt building needs them. */
export interface GroupPromptContext {
  members: readonly GroupMember[];
  /** The member replying now. */
  speakerId: string;
  generationMode: number;
  joinPrefix: string;
  joinSuffix: string;
}

/** Card fields joined across members (SillyTavern `getGroupCharacterCards`); null in swap mode. */
export interface GroupCards {
  description: string;
  personality: string;
  scenario: string;
  mesExamples: string;
}

/**
 * Joins the members' card fields for the append modes. `substitute(text, charName)` expands macros
 * as SillyTavern's `baseChatReplace` with the member as `{{char}}`.
 */
export function groupCharacterCards(
  group: GroupPromptContext,
  overrides: { scenario?: string; mesExamples?: string },
  substitute: (text: string, charName: string | null) => string,
): GroupCards | null {
  if (!group.generationMode || !group.members.length) return null;
  const transform = (value: string, field: string, name: string, trim: boolean) => {
    if (!value) return '';
    value = value.replace(/<FIELDNAME>/gi, field);
    return substitute(trim ? value.trim() : value, name);
  };
  const collect = (
    field: string,
    get: (card: CardData) => string,
    preprocess?: (value: string) => string,
  ) => {
    const values: string[] = [];
    for (const member of group.members) {
      const skip =
        member.muted &&
        member.id !== group.speakerId &&
        group.generationMode !== GroupGenerationMode.APPEND_DISABLED;
      if (skip) continue;
      let value = get(cardData(member.card)).trim();
      if (!value) continue;
      if (preprocess) value = preprocess(value);
      const prefix = transform(group.joinPrefix, field, member.name, false);
      const suffix = transform(group.joinSuffix, field, member.name, false);
      values.push(`${prefix}${transform(value, field, member.name, true)}${suffix}`);
    }
    return values.filter((x) => x.length).join('\n');
  };
  const override = (text: string | undefined) => (text?.trim() ? substitute(text.trim(), null) : '');
  return {
    description: collect('Description', (c) => c.description),
    personality: collect('Personality', (c) => c.personality),
    scenario: override(overrides.scenario) || collect('Scenario', (c) => c.scenario),
    mesExamples:
      override(overrides.mesExamples) ||
      collect(
        'Example Messages',
        (c) => c.mes_example,
        (x) => (x.startsWith('<START>') ? x : `<START>\n${x}`),
      ),
  };
}

/** Every member's character note in the append modes (SillyTavern `getGroupDepthPrompts`). */
export function groupDepthPrompts(
  group: GroupPromptContext,
  substitute: (text: string, charName: string) => string,
): { text: string; depth: number; role: string }[] {
  if (group.generationMode === GroupGenerationMode.SWAP) return [];
  const prompts: { text: string; depth: number; role: string }[] = [];
  for (const member of group.members) {
    if (member.muted && member.id !== group.speakerId) continue;
    const prompt = cardData(member.card).extensions.depth_prompt;
    const text = prompt?.prompt?.trim() ? substitute(prompt.prompt.trim(), member.name) : '';
    if (text) prompts.push({ text, depth: prompt?.depth ?? 4, role: prompt?.role ?? 'system' });
  }
  return prompts;
}

const escapeRegex = (text: string) => text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');

/**
 * Cuts a reply where it starts speaking for another member (SillyTavern `cleanGroupMessage`).
 */
export function cleanGroupMessage(text: string, memberNames: readonly string[], speaker: string): string {
  for (const name of memberNames) {
    if (name === speaker) continue;
    const match = new RegExp(`(^|\n)${escapeRegex(name)}:`).exec(text);
    if (match) text = text.substring(0, match.index);
  }
  return text;
}

/**
 * `{{group}}` (every member), `{{groupNotMuted}}` and `{{notChar}}` (the other unmuted members) in a
 * group chat, as SillyTavern's macro engine gives them.
 */
export function groupMacroNames(members: readonly GroupMember[], speakerName: string) {
  const unmuted = members.filter((m) => !m.muted).map((m) => m.name);
  return {
    isGroup: true,
    group: members.map((m) => m.name).join(', '),
    groupNotMuted: unmuted.join(', '),
    notChar: unmuted.filter((n) => n !== speakerName).join(', '),
  };
}
