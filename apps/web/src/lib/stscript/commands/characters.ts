/**
 * Commands about who is in the chat: opening characters and groups, group members, tags and
 * personas (SillyTavern `slash-commands.js`, `tags.js`, `personas.js`, `power-user.js`).
 */

import type { CharacterSummary, Group, Persona, Tag } from '@bakatavern/api-client';
import {
  ArgType,
  isFalseBoolean,
  isTrueBoolean,
  stringToRange,
  type NamedArguments,
  type Stscript,
} from '@bakatavern/core';

import { api } from '../../api.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { library } from '../../state/library.svelte.ts';
import { personaDefaults } from '../../state/prefs.ts';
import { settings } from '../../state/settings.svelte.ts';
import { ui } from '../../state/ui.svelte.ts';
import { scriptDialogs } from '../dialogs.svelte.ts';
import { avatarKey, findCharacter, findGroupMember, findPersona, sameName, thumbnailUrl } from '../lookup.ts';
import { addCommands } from '../runtime.svelte.ts';

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const memberArg = {
  description: 'member index (starts with 0) or name',
  typeList: [ArgType.NUMBER, ArgType.STRING],
  isRequired: true,
};
const charNameArg = {
  name: 'name',
  description: 'Character name - or unique character identifier (avatar key)',
  defaultValue: '{{char}}',
};

/** The open group, or a warning that the command needs one. */
function openGroup(command: string): Group | null {
  if (!chat.group) ui.toast(t('script.needGroup', { command }), 'warning');
  return chat.group;
}

/** A character or group by name, else the open one (SillyTavern `searchCharByName`). */
function tagTarget(
  name: unknown,
): { kind: 'character'; entity: CharacterSummary } | { kind: 'group'; entity: Group } | null {
  const text = str(name);
  if (text) {
    const character = findCharacter(text);
    if (character) return { kind: 'character', entity: character };
    const group = library.groups.find((g) => sameName(g.name, text));
    if (group) return { kind: 'group', entity: group };
  } else if (chat.group) {
    return { kind: 'group', entity: chat.group };
  } else if (chat.character) {
    const summary = library.character(chat.character.id);
    if (summary) return { kind: 'character', entity: summary };
  }
  ui.toast(t('script.characterNotFound', { name: text }), 'warning');
  return null;
}

async function setEntityTags(target: NonNullable<ReturnType<typeof tagTarget>>, tagIds: string[]) {
  if (target.kind === 'character') {
    library.upsertCharacter(await api.setCharacterTags(target.entity.id, tagIds));
  } else {
    const group = await api.setGroupTags(target.entity.id, tagIds);
    library.upsertGroup(group);
    if (chat.group?.id === group.id) chat.group = group;
  }
}

function findTag(name: string): Tag | undefined {
  return library.tags.find((tag) => sameName(tag.name, name));
}

/** The persona a command is about: `persona=`, else the one in use (SillyTavern `getTargetPersona`). */
function targetPersona(name: unknown): Persona | undefined {
  const text = str(name);
  const persona = text ? findPersona(text) : chat.persona;
  if (!persona) ui.toast(t('script.personaNotFound', { name: text }), 'warning');
  return persona;
}

type LockType = 'chat' | 'character' | 'default';

function isPersonaLocked(type: LockType): boolean {
  const persona = chat.persona;
  if (!persona) return false;
  const prefs = settings.get('persona', personaDefaults);
  switch (type) {
    case 'chat': {
      const locked = str(chat.chat?.metadata.persona);
      return locked === persona.id || (!!persona.sourceFile && locked === persona.sourceFile);
    }
    case 'character': {
      const owner = chat.groupId ?? chat.characterId;
      return !!owner && prefs.characterPersona[owner] === persona.id;
    }
    case 'default':
      return prefs.defaultPersonaId === persona.id;
  }
}

async function setPersonaLock(type: LockType, locked: boolean) {
  const persona = chat.persona;
  if (!persona) return;
  const prefs = settings.get('persona', personaDefaults);
  switch (type) {
    case 'chat':
      await chat.updateMetadata({ persona: locked ? persona.id : undefined });
      break;
    case 'character': {
      const owner = chat.groupId ?? chat.characterId;
      if (!owner) return;
      const characterPersona = { ...prefs.characterPersona };
      if (locked) characterPersona[owner] = persona.id;
      else delete characterPersona[owner];
      settings.update('persona', { characterPersona });
      break;
    }
    case 'default':
      settings.update('persona', { defaultPersonaId: locked ? persona.id : null });
      break;
  }
}

export function registerCharacterCommands(st: Stscript) {
  // Opening characters and groups
  st.commands
    .add({
      name: 'go',
      aliases: ['char'],
      helpString: 'Opens up a chat with the character or group by its name',
      unnamedArgumentList: [
        { description: 'Character name - or unique character identifier (avatar key)', isRequired: true },
      ],
      callback: async (_args, value) => {
        const name = str(value);
        if (!name) return '';
        const character = findCharacter(name);
        if (character) {
          await chat.openCharacter(character.id);
          return character.name;
        }
        const group = library.groups.find((g) => sameName(g.name, name));
        if (group) {
          await chat.openGroup(group.id);
          return group.name;
        }
        return '';
      },
    })
    .add({
      name: 'random',
      helpString:
        'Start a new chat with a random character. If an argument is provided, only considers characters that have the specified tag.',
      unnamedArgumentList: [{ description: 'optional tag name' }],
      callback: async (_args, value) => {
        const tagName = str(value);
        let pool = library.characters;
        if (tagName) {
          const tag = findTag(tagName);
          pool = tag ? pool.filter((c) => c.tags.includes(tag.id)) : [];
        }
        const character = pool[Math.floor(Math.random() * pool.length)];
        if (!character) {
          ui.toast(t('script.noCharacters'), 'error');
          return '';
        }
        await chat.openCharacter(character.id);
        return '';
      },
    })
    .add({
      name: 'char-find',
      aliases: ['findchar'],
      helpString:
        'Searches for a character and returns its avatar key. Prefers the current character or group members when several match.',
      namedArgumentList: [
        {
          name: 'tag',
          description: 'Supply one or more tags to filter down to the correct character',
          acceptsMultiple: true,
        },
        {
          name: 'preferCurrent',
          description: 'Prefer current character or characters in a group',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        },
        {
          name: 'quiet',
          description: 'Do not show warning if multiple characters are found',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'Character name - or unique character identifier (avatar key)' }],
      callback: (args, value) => {
        if (typeof value !== 'string') throw new Error('name must be a string');
        const tags =
          args.tag === undefined ? undefined : (Array.isArray(args.tag) ? args.tag : [args.tag]).map(str);
        const character = findCharacter(value, !isFalseBoolean(str(args.preferCurrent)), {
          tags,
          quiet: isTrueBoolean(str(args.quiet)),
        });
        return character ? avatarKey(character) : '';
      },
    })
    .add({
      name: 'char-get',
      aliases: ['char-data'],
      helpString: 'Retrieves character data. Can get all data or a specific field.',
      namedArgumentList: [
        {
          name: 'char',
          description:
            'Character name or avatar key. If not provided, uses the currently selected character.',
        },
        {
          name: 'field',
          description: 'Specific field to retrieve. If not provided, returns the entire character data.',
        },
        {
          name: 'return',
          description: 'The way how you want the return value to be provided',
          defaultValue: 'pipe',
        },
      ],
      callback: async (args) => characterData(st, args),
    });

  // Group members
  const memberAction =
    (command: string, action: (member: { characterId: string; index: number }) => Promise<void>) =>
    async (_args: NamedArguments, value: unknown) => {
      if (!openGroup(command)) return '';
      const member = findGroupMember(value);
      if (member) await action(member);
      return '';
    };
  const setMembers = (members: Group['members']) => chat.updateGroup({ members });
  const move = (index: number, by: number) => {
    const members = [...(chat.group?.members ?? [])];
    const target = index + by;
    if (target < 0 || target >= members.length) return Promise.resolve();
    [members[index], members[target]] = [members[target]!, members[index]!];
    return setMembers(members);
  };

  st.commands
    .add({
      name: 'member-get',
      aliases: ['getmember', 'memberget'],
      helpString: "Retrieves a group member's name, index, id, or avatar.",
      namedArgumentList: [
        {
          name: 'field',
          description: 'Whether to retrieve the name, index, id, or avatar.',
          isRequired: true,
          defaultValue: 'name',
          enumList: ['name', 'index', 'id', 'avatar'],
        },
      ],
      unnamedArgumentList: [memberArg],
      callback: (args, value) => {
        if (!openGroup('/member-get')) return '';
        const field = str(args.field ?? 'name');
        if (!['name', 'index', 'id', 'avatar'].includes(field)) {
          ui.toast(t('script.memberField'), 'warning');
          return '';
        }
        const member = findGroupMember(value);
        if (!member) {
          ui.toast(t('script.noMember', { member: str(value) }), 'warning');
          return '';
        }
        return field === 'id' ? member.characterId : member[field as 'name' | 'index' | 'avatar'];
      },
    })
    .add({
      name: 'member-disable',
      aliases: ['disable', 'disablemember', 'memberdisable'],
      helpString: 'Disables a group member from being drafted for replies.',
      unnamedArgumentList: [memberArg],
      callback: memberAction('/member-disable', (m) => chat.setMuted(m.characterId, true)),
    })
    .add({
      name: 'member-enable',
      aliases: ['enable', 'enablemember', 'memberenable'],
      helpString: 'Enables a group member to be drafted for replies.',
      unnamedArgumentList: [memberArg],
      callback: memberAction('/member-enable', (m) => chat.setMuted(m.characterId, false)),
    })
    .add({
      name: 'member-add',
      aliases: ['addmember', 'memberadd'],
      helpString: 'Adds a new group member to the group chat.',
      unnamedArgumentList: [
        { description: 'Character name - or unique character identifier (avatar key)', isRequired: true },
      ],
      callback: async (_args, value) => {
        const group = openGroup('/member-add');
        if (!group || !value) return '';
        const character = findCharacter(str(value), false);
        if (!character) return '';
        if (group.members.some((m) => m.characterId === character.id)) {
          ui.toast(t('script.alreadyMember', { name: character.name }), 'warning');
          return '';
        }
        await setMembers([...group.members, { characterId: character.id, muted: false }]);
        return character.name;
      },
    })
    .add({
      name: 'member-remove',
      aliases: ['removemember', 'memberremove'],
      helpString: 'Removes a group member from the group chat.',
      unnamedArgumentList: [memberArg],
      callback: memberAction('/member-remove', (m) =>
        setMembers((chat.group?.members ?? []).filter((x) => x.characterId !== m.characterId)),
      ),
    })
    .add({
      name: 'member-up',
      aliases: ['upmember', 'memberup'],
      helpString: 'Moves a group member up in the group chat list.',
      unnamedArgumentList: [memberArg],
      callback: memberAction('/member-up', (m) => move(m.index, -1)),
    })
    .add({
      name: 'member-down',
      aliases: ['downmember', 'memberdown'],
      helpString: 'Moves a group member down in the group chat list.',
      unnamedArgumentList: [memberArg],
      callback: memberAction('/member-down', (m) => move(m.index, 1)),
    })
    .add({
      name: 'member-peek',
      aliases: ['peek', 'memberpeek', 'peekmember'],
      helpString: 'Shows a group member character card without switching chats.',
      unnamedArgumentList: [memberArg],
      callback: async (args, value) => {
        if (chat.groupRunning) {
          ui.toast(t('script.peekBusy'), 'warning');
          return '';
        }
        return memberAction('/member-peek', async (m) => {
          ui.editingCharacterId = m.characterId;
        })(args, value);
      },
    })
    .add({
      name: 'member-count',
      aliases: ['countmember', 'membercount'],
      helpString: 'Returns the total number of group members in the group chat list.',
      callback: () => {
        const group = openGroup('/member-count');
        return group ? String(group.members.length) : '';
      },
    });

  // Tags
  st.commands
    .add({
      name: 'tag-add',
      helpString:
        "Adds a tag to the character. If no character is provided, it adds it to the current character. If the tag doesn't exist, it is created.",
      namedArgumentList: [charNameArg],
      unnamedArgumentList: [{ description: 'tag name', isRequired: true }],
      callback: async (args, value) => {
        const target = tagTarget(args.name);
        if (!target) return 'false';
        const name = str(value);
        if (!name) {
          ui.toast(t('script.needTagName'), 'warning');
          return 'false';
        }
        let tag = findTag(name);
        if (!tag) {
          tag = await api.createTag(name);
          await library.refreshTags();
        }
        if (target.entity.tags.includes(tag.id)) return 'false';
        await setEntityTags(target, [...target.entity.tags, tag.id]);
        return 'true';
      },
    })
    .add({
      name: 'tag-remove',
      helpString:
        'Removes a tag from the character. If no character is provided, it removes it from the current character.',
      namedArgumentList: [charNameArg],
      unnamedArgumentList: [{ description: 'tag name', isRequired: true }],
      callback: async (args, value) => {
        const target = tagTarget(args.name);
        if (!target) return 'false';
        const tag = findTag(str(value));
        if (!tag) {
          ui.toast(t('script.noTag', { name: str(value) }), 'warning');
          return 'false';
        }
        if (!target.entity.tags.includes(tag.id)) return 'false';
        await setEntityTags(
          target,
          target.entity.tags.filter((id) => id !== tag.id),
        );
        return 'true';
      },
    })
    .add({
      name: 'tag-exists',
      helpString:
        'Checks whether the given tag is assigned to the character. If no character is provided, it checks the current character.',
      namedArgumentList: [charNameArg],
      unnamedArgumentList: [{ description: 'tag name', isRequired: true }],
      callback: (args, value) => {
        const target = tagTarget(args.name);
        if (!target) return 'false';
        const tag = findTag(str(value));
        if (!tag) {
          ui.toast(t('script.noTag', { name: str(value) }), 'warning');
          return 'false';
        }
        return String(target.entity.tags.includes(tag.id));
      },
    })
    .add({
      name: 'tag-list',
      helpString:
        'Lists all assigned tags of the character. If no character is provided, it uses the current character.',
      namedArgumentList: [charNameArg],
      callback: (args) => {
        const target = tagTarget(args.name);
        if (!target) return '';
        return library.tags
          .filter((tag) => target.entity.tags.includes(tag.id))
          .sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
          )
          .map((tag) => tag.name)
          .join(', ');
      },
    });

  // Personas
  st.commands
    .add({
      name: 'persona-set',
      aliases: ['persona', 'name'],
      helpString: 'Selects an existing persona by name or avatar key, or sets a temporary user name.',
      namedArgumentList: [
        {
          name: 'mode',
          description: 'The mode for persona selection',
          defaultValue: 'all',
          enumList: ['lookup', 'temp', 'all'],
        },
      ],
      unnamedArgumentList: [{ description: 'persona name', isRequired: true }],
      callback: async (args, value) => {
        const mode = str(args.mode ?? 'all');
        const name = str(value).trim();
        if (!name) {
          ui.toast(t('script.needPersonaName'), 'warning');
          return '';
        }
        if (!['lookup', 'temp', 'all'].includes(mode)) {
          ui.toast(t('script.personaMode'), 'warning');
          return '';
        }
        if (mode !== 'temp') {
          const persona = findPersona(name);
          if (persona) {
            await chat.selectPersona(persona);
            return '';
          }
          if (mode === 'lookup') {
            ui.toast(t('script.personaNotFound', { name }), 'warning');
            return '';
          }
        }
        chat.tempUserName = name;
        return '';
      },
    })
    .add({
      name: 'persona-lock',
      aliases: ['lock', 'bind'],
      helpString:
        'Locks/unlocks the current persona to a chat, character, or as the default. Returns the lock state if no value is provided.',
      namedArgumentList: [
        {
          name: 'type',
          description: 'The type of the lock, where it should apply to',
          defaultValue: 'chat',
          enumList: ['chat', 'character', 'default'],
        },
      ],
      unnamedArgumentList: [{ description: 'state', enumList: ['on', 'off', 'toggle'] }],
      callback: async (args, value) => {
        const type = str(args.type ?? 'chat') as LockType;
        if (!['chat', 'character', 'default'].includes(type)) {
          ui.toast(t('script.lockType', { type }), 'warning');
          return '';
        }
        const state = str(value);
        if (!state) return String(isPersonaLocked(type));
        if (['toggle', 't'].includes(state.trim().toLowerCase())) {
          const next = !isPersonaLocked(type);
          await setPersonaLock(type, next);
          return String(next);
        }
        if (isTrueBoolean(state)) {
          await setPersonaLock(type, true);
          return 'true';
        }
        if (isFalseBoolean(state)) {
          await setPersonaLock(type, false);
          return 'false';
        }
        return '';
      },
    })
    .add({
      name: 'persona-sync',
      aliases: ['sync'],
      helpString: 'Syncs the user persona in user-attributed messages in the current chat.',
      namedArgumentList: [
        { name: 'from', description: 'only sync messages from a certain persona name' },
        {
          name: 'quiet',
          description: 'suppress the confirmation popup',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        },
      ],
      unnamedArgumentList: [
        {
          description: 'message index (starts with 0) or range, syncs all user messages if not provided',
          typeList: [ArgType.NUMBER, ArgType.RANGE],
        },
      ],
      callback: async (args, value) => {
        const last = chat.messages.length - 1;
        const range = value ? stringToRange(str(value), 0, last) : null;
        if (value && !range) return '';
        const start = range ? range.start : 0;
        const end = range ? range.end : last;
        const from = typeof args.from === 'string' ? args.from.trim() : '';
        if (isFalseBoolean(str(args.quiet))) {
          const answer = await scriptDialogs.open({
            kind: 'popup',
            header: t('script.areYouSure'),
            body: t('script.syncConfirm', { name: chat.userName }),
            okButton: t('script.ok'),
            cancelButton: t('common.cancel'),
          });
          if (answer !== 1) return '';
        }
        const persona = chat.persona;
        for (let i = start; i <= end; i++) {
          const message = chat.messages[i];
          if (message?.role !== 'user' || (from && !sameName(message.name, from))) continue;
          const data = { ...(message.data as Record<string, unknown>) };
          if (persona?.sourceFile) data.force_avatar = thumbnailUrl(persona.sourceFile);
          else delete data.force_avatar;
          await chat.updateMessageFields(i, { name: chat.userName, data });
        }
        return '';
      },
    })
    .add({
      name: 'persona-get',
      aliases: ['persona-data'],
      helpString: 'Retrieves persona data. Can return all data as JSON or a specific field value.',
      namedArgumentList: [
        {
          name: 'persona',
          description: 'Persona name or avatar key. If not provided, uses the current persona.',
        },
        {
          name: 'field',
          description:
            'Specific field to retrieve. If not provided, returns the entire persona data as JSON.',
        },
        { name: 'return', description: 'The way to return the result', defaultValue: 'pipe' },
      ],
      callback: async (args) => {
        const persona = targetPersona(args.persona);
        if (!persona) return '';
        const prefs = settings.get('persona', personaDefaults);
        const connections = Object.entries(prefs.characterPersona)
          .filter(([, id]) => id === persona.id)
          .map(([owner]) =>
            library.group(owner) ? { type: 'group', id: owner } : { type: 'character', id: owner },
          );
        const data: Record<string, unknown> = {
          avatar: persona.sourceFile ?? persona.id,
          name: persona.name,
          description: persona.description,
          title: str((persona.data as { title?: unknown }).title),
          position: persona.position,
          depth: persona.depth,
          role: persona.role,
          lorebook: persona.lorebook ?? '',
          default: prefs.defaultPersonaId === persona.id,
          connections,
        };
        const toText = (x: unknown) => (typeof x === 'object' ? JSON.stringify(x) : String(x));
        if (args.field !== undefined) {
          const field = str(args.field);
          if (!(field in data)) {
            ui.toast(t('script.personaField', { field }), 'warning');
            return '';
          }
          return st.doReturn(str(args.return ?? 'pipe'), data[field], { toText });
        }
        return st.doReturn(str(args.return ?? 'pipe'), data, { toText: (x) => JSON.stringify(x, null, 2) });
      },
    });
}

/** `/char-get`: a character's card fields (SillyTavern `getCharacterDataCallback`). */
async function characterData(st: Stscript, args: NamedArguments): Promise<string> {
  let summary: CharacterSummary | null | undefined;
  if (args.char !== undefined) {
    summary = findCharacter(str(args.char));
    if (!summary) {
      ui.toast(t('script.characterNotFound', { name: str(args.char) }), 'warning');
      return '';
    }
  } else {
    summary = library.character(chat.characterId);
    if (!summary) {
      ui.toast(t('script.noCharacterArg'), 'warning');
      return '';
    }
  }
  const character = await api.getCharacter(summary.id);
  const card = character.card as Record<string, unknown> & {
    data?: Record<string, unknown> & { extensions?: Record<string, unknown> };
  };
  const data = card.data ?? {};
  const talkativeness = data.extensions?.talkativeness ?? card.talkativeness ?? 0.5;
  const tags = data.tags ?? card.tags ?? [];
  if (args.field !== undefined) {
    const field = str(args.field);
    let value: unknown = field === 'avatar' ? avatarKey(character) : (data[field] ?? card[field]);
    if (field === 'talkativeness') value = talkativeness;
    if (field === 'tags') value = Array.isArray(tags) ? tags.join(', ') : tags;
    if (field === 'fav') value = character.fav;
    if (value === undefined) return '';
    return st.doReturn(str(args.return ?? 'pipe'), value, { toText: (x) => String(x) });
  }
  const text = (key: string) => card[key] ?? data[key] ?? '';
  const result = {
    avatar: avatarKey(character),
    name: character.name,
    description: text('description'),
    personality: text('personality'),
    scenario: text('scenario'),
    first_mes: text('first_mes'),
    mes_example: text('mes_example'),
    creator_notes: data.creator_notes ?? '',
    system_prompt: data.system_prompt ?? '',
    post_history_instructions: data.post_history_instructions ?? '',
    creator: data.creator ?? '',
    character_version: data.character_version ?? '',
    tags,
    talkativeness,
    fav: character.fav,
    chat: chat.characterId === character.id ? (chat.chat?.title ?? '') : '',
    create_date: card.create_date,
  };
  return st.doReturn(str(args.return ?? 'pipe'), result, { toText: (x) => JSON.stringify(x, null, 2) });
}

addCommands(registerCharacterCommands);
