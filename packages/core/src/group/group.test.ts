import { describe, expect, it } from 'vitest';

import { seededRandom } from '../util/random.ts';
import {
  cleanGroupMessage,
  GroupActivation,
  GroupGenerationMode,
  groupCharacterCards,
  groupDepthPrompts,
  groupMacroNames,
  normalizeGroupSettings,
  selectSpeakers,
  talkativeness,
  type GroupChatMessage,
  type GroupMember,
} from './index.ts';

const card = (name: string, data: Record<string, unknown> = {}) => ({
  spec: 'chara_card_v2',
  data: { name, ...data, extensions: { talkativeness: '0.5', ...(data.extensions as object) } },
});

const member = (
  id: string,
  name: string,
  data: Record<string, unknown> = {},
  muted = false,
): GroupMember => ({
  id,
  name,
  card: card(name, data),
  muted,
});

const silent = { extensions: { talkativeness: '0' } };
const alice = member('a', 'Alice', silent);
const bob = member('b', 'Bob', silent);
const carol = member('c', 'Carol', silent);

const said = (name: string, text: string, characterId?: string): GroupChatMessage => ({
  name,
  role: characterId ? 'assistant' : 'user',
  hidden: false,
  characterId,
  text,
});

const natural = { activation_strategy: GroupActivation.NATURAL, allow_self_responses: false };

describe('speaker selection', () => {
  it('activates members mentioned by name, in the order they are mentioned', () => {
    const speakers = selectSpeakers({
      type: 'normal',
      settings: natural,
      members: [alice, bob, carol],
      messages: [],
      input: 'carol and then alice?',
      random: seededRandom(1),
    });
    expect(speakers).toEqual(['c', 'a']);
  });

  it('finds names written without spaces around them (Chinese)', () => {
    const xiao = member('x', '小明', silent);
    const hong = member('h', '小红', silent);
    const speakers = selectSpeakers({
      type: 'normal',
      settings: natural,
      members: [xiao, hong],
      messages: [],
      input: '小红你好，小明呢？',
      random: seededRandom(1),
    });
    expect(speakers).toEqual(['h', 'x']);
  });

  it('keeps the last speaker from answering itself unless allowed', () => {
    const messages = [said('Bob', 'Alice, what do you think?', 'b')];
    const base = { type: 'auto' as const, members: [alice, bob], messages, random: seededRandom(3) };
    expect(selectSpeakers({ ...base, settings: natural })).toEqual(['a']);
    // Bob mentions nobody but himself: with self responses he may reply.
    const own = [said('Bob', 'Bob agrees with Bob.', 'b')];
    expect(
      selectSpeakers({ ...base, messages: own, settings: { ...natural, allow_self_responses: true } }),
    ).toEqual(['b']);
  });

  it('picks talkative members and falls back to a random one', () => {
    const chatty = member('t', 'Tom', { extensions: { talkativeness: '1' } });
    expect(
      selectSpeakers({
        type: 'normal',
        settings: natural,
        members: [alice, chatty],
        messages: [],
        input: 'hello',
        random: seededRandom(5),
      }),
    ).toEqual(['t']);
    const one = selectSpeakers({
      type: 'normal',
      settings: natural,
      members: [alice, bob],
      messages: [],
      input: 'hello',
      random: seededRandom(5),
    });
    expect(one).toHaveLength(1);
  });

  it('leaves muted members out unless forced', () => {
    const quiet = { ...carol, muted: true };
    const list = { activation_strategy: GroupActivation.LIST, allow_self_responses: false };
    const base = { type: 'normal' as const, settings: list, members: [alice, bob, quiet], messages: [] };
    expect(selectSpeakers({ ...base, input: 'hi' })).toEqual(['a', 'b']);
    expect(selectSpeakers({ ...base, forced: 'c' })).toEqual(['c']);
  });

  it('pools: one member who has not spoken since the user', () => {
    const pooled = { activation_strategy: GroupActivation.POOLED, allow_self_responses: false };
    const messages = [said('User', 'hi'), said('Alice', 'Hello!', 'a'), said('Bob', 'Hey.', 'b')];
    expect(
      selectSpeakers({
        type: 'auto',
        settings: pooled,
        members: [alice, bob, carol],
        messages,
        random: seededRandom(9),
      }),
    ).toEqual(['c']);
  });

  it('waits for the user in manual mode', () => {
    const manual = { activation_strategy: GroupActivation.MANUAL, allow_self_responses: false };
    const base = { settings: manual, members: [alice, bob], messages: [] };
    expect(selectSpeakers({ ...base, type: 'normal', input: 'hi' })).toEqual([]);
    expect(selectSpeakers({ ...base, type: 'auto' })).toHaveLength(1);
  });

  it('swipes and continues with the last reply’s author', () => {
    const messages = [said('Alice', 'Hello!', 'a'), said('Bob', 'Hey.', 'b')];
    const base = { settings: natural, members: [alice, bob], messages };
    expect(selectSpeakers({ ...base, type: 'swipe' })).toEqual(['b']);
    expect(selectSpeakers({ ...base, type: 'continue' })).toEqual(['b']);
    // Old messages without an author are matched by name.
    expect(
      selectSpeakers({
        ...base,
        messages: [{ ...said('Alice', 'Hi'), role: 'assistant' }],
        type: 'swipe',
      }),
    ).toEqual(['a']);
  });
});

describe('group prompts', () => {
  const sub = (text: string, name: string | null) => text.replaceAll('{{char}}', name ?? 'Speaker');
  const members = [
    member('a', 'Alice', {
      description: '{{char}} is a knight.',
      personality: 'brave',
      scenario: 'A castle.',
      mes_example: '{{user}}: Hi\n{{char}}: Hail!',
      extensions: { depth_prompt: { prompt: '{{char}} guards the gate.', depth: 2, role: 'user' } },
    }),
    member('b', 'Bob', { description: '{{char}} is a bard.', personality: '', scenario: 'A tavern.' }, true),
  ];
  const context = {
    members,
    speakerId: 'a',
    generationMode: GroupGenerationMode.APPEND,
    joinPrefix: '[<FIELDNAME> of {{char}}: ',
    joinSuffix: ']',
  };

  it('joins the cards of unmuted members (and the speaker)', () => {
    expect(groupCharacterCards(context, {}, sub)).toEqual({
      description: '[Description of Alice: Alice is a knight.]',
      personality: '[Personality of Alice: brave]',
      scenario: '[Scenario of Alice: A castle.]',
      mesExamples: '[Example Messages of Alice: <START>\n{{user}}: Hi\nAlice: Hail!]',
    });
    const all = groupCharacterCards(
      { ...context, generationMode: GroupGenerationMode.APPEND_DISABLED },
      { scenario: 'Override for {{char}}' },
      sub,
    );
    expect(all?.description).toBe(
      '[Description of Alice: Alice is a knight.]\n[Description of Bob: Bob is a bard.]',
    );
    expect(all?.scenario).toBe('Override for Speaker');
    expect(groupCharacterCards({ ...context, generationMode: GroupGenerationMode.SWAP }, {}, sub)).toBeNull();
  });

  it('collects every unmuted member’s character note', () => {
    expect(groupDepthPrompts(context, sub)).toEqual([
      { text: 'Alice guards the gate.', depth: 2, role: 'user' },
    ]);
    expect(groupDepthPrompts({ ...context, generationMode: GroupGenerationMode.SWAP }, sub)).toEqual([]);
  });

  it('names the group for macros', () => {
    expect(groupMacroNames(members, 'Alice')).toEqual({
      isGroup: true,
      group: 'Alice, Bob',
      groupNotMuted: 'Alice',
      notChar: '',
    });
  });

  it('cuts a reply where another member starts talking', () => {
    expect(cleanGroupMessage('Hello.\nBob: Hi!', ['Alice', 'Bob'], 'Alice')).toBe('Hello.');
    expect(cleanGroupMessage('Alice: Hello.', ['Alice', 'Bob'], 'Alice')).toBe('Alice: Hello.');
  });

  it('reads settings and talkativeness like SillyTavern', () => {
    expect(normalizeGroupSettings({ activation_strategy: '3' }).activation_strategy).toBe(3);
    expect(normalizeGroupSettings(null).auto_mode_delay).toBe(5);
    expect(talkativeness(card('X', { extensions: { talkativeness: '' } }))).toBe(0.5);
    expect(talkativeness(card('X', { extensions: { talkativeness: '0.25' } }))).toBe(0.25);
  });
});
