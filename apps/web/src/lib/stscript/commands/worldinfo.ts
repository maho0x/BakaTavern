/**
 * World Info commands: which books are active or bound, and reading and writing entries
 * (SillyTavern `world-info.js` `registerWorldInfoSlashCommands`).
 */

import type { Lorebook } from '@bakatavern/api-client';
import {
  ArgType,
  createEntry,
  fuzzySearch,
  GENERATION_TRIGGERS,
  isFalseBoolean,
  isTrueBoolean,
  parseStringArray,
  uniqueName,
  type Stscript,
  type TimedEffect,
  type TimedWorldInfoState,
  type WorldInfoEntry,
} from '@bakatavern/core';

import { api } from '../../api.ts';
import { characterKey, macros } from '../../generation/pipeline.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { library } from '../../state/library.svelte.ts';
import { worldInfoDefaults } from '../../state/prefs.ts';
import { settings } from '../../state/settings.svelte.ts';
import { ui } from '../../state/ui.svelte.ts';
import { avatarKey, findCharacter } from '../lookup.ts';
import { addCommands } from '../runtime.svelte.ts';

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));

/** Fields an entry has, with their defaults (SillyTavern `newWorldInfoEntryDefinition`). */
const entryTemplate: Record<string, unknown> = (() => {
  const { uid: _uid, displayIndex: _displayIndex, ...fields } = createEntry(0);
  return fields;
})();
const filterFields: Record<string, unknown> = {
  characterFilterNames: [],
  characterFilterTags: [],
  characterFilterExclude: false,
};
const isEntryField = (field: string) => field in entryTemplate || field in filterFields;
const fieldDefault = (field: string) =>
  structuredClone(field in entryTemplate ? entryTemplate[field] : filterFields[field]);

const TIMED_EFFECTS = ['sticky', 'cooldown', 'delay'];

const expand = (text: string) => macros.evaluate(text, chat.macroEnv());

/** A file name from a free-form one (SillyTavern's `Chat Book …` names). */
const bookFileName = (base: string) =>
  base
    .replace(/[^a-z0-9 -]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 64);

function bookInfo(name: unknown) {
  return library.lorebooks.find((b) => b.name === str(name));
}

/** A book's entries; warns and gives nothing when the book is missing or empty. */
async function entriesOf(file: unknown): Promise<{ book: Lorebook; entries: WorldInfoEntry[] } | null> {
  const info = bookInfo(file);
  if (!info) {
    ui.toast(t('wiCmd.needBook'), 'warning');
    return null;
  }
  const book = await api.getLorebook(info.id);
  const entries = book.entries as unknown as WorldInfoEntry[];
  if (!entries.length) {
    ui.toast(t('wiCmd.noEntries'), 'warning');
    return null;
  }
  return { book, entries };
}

/** Creates a book with the given name (it must be free) or a free one based on `fallback`. */
async function createBook(name: unknown, fallback: string): Promise<string> {
  const taken = (n: string) => library.lorebooks.some((b) => b.name === n);
  if (typeof name === 'string') {
    if (taken(name)) throw new Error(t('wiCmd.nameTaken'));
  }
  const chosen = uniqueName(typeof name === 'string' ? name : fallback, taken);
  await api.createLorebook(chosen);
  await library.refreshLorebooks();
  return chosen;
}

async function saveEntry(book: Lorebook, entry: WorldInfoEntry) {
  await api.upsertLorebookEntry(book.id, entry);
  await library.refreshLorebooks();
}

/** The chat's sticky/cooldown state, as the scan keeps it (SillyTavern `timedWorldInfo`). */
function timedState(): Required<TimedWorldInfoState> & Record<string, Record<string, TimedEffect>> {
  const state = structuredClone(
    (chat.chat?.metadata.timedWorldInfo as TimedWorldInfoState | undefined) ?? {},
  ) as Record<string, Record<string, TimedEffect>>;
  for (const type of ['sticky', 'cooldown']) {
    if (!state[type] || typeof state[type] !== 'object') state[type] = {};
  }
  return state as Required<TimedWorldInfoState> & Record<string, Record<string, TimedEffect>>;
}

/** Messages World Info scans: the ones not hidden (SillyTavern `getScanningChat`). */
const scanLength = () => chat.messages.filter((m) => !m.hidden).length;

export function registerWorldInfoCommands(st: Stscript) {
  st.commands
    .add({
      name: 'world',
      helpString:
        'Sets active World, or unsets if no args provided, use state=off and state=toggle to deactivate or toggle a World, use silent=true to suppress toast messages.',
      namedArgumentList: [
        { name: 'state', description: 'set world state', enumList: ['on', 'off', 'toggle'] },
        { name: 'silent', description: 'suppress toast messages', typeList: [ArgType.BOOLEAN] },
      ],
      unnamedArgumentList: [{ description: 'world name' }],
      callback: (args, value) => {
        const silent = isTrueBoolean(str(args.silent));
        const prefs = settings.get('worldinfo', worldInfoDefaults);
        const text = str(value).trim();
        if (!text) {
          if (!silent) ui.toast(t('wiCmd.allOff'), 'success');
          settings.update('worldinfo', { globalBooks: [] });
          return '';
        }
        const active = [...prefs.globalBooks];
        for (const wanted of text.toLowerCase().split(',')) {
          const name = library.lorebooks.find((b) => b.name.toLowerCase() === wanted)?.name;
          if (!name) {
            if (!silent) ui.toast(t('wiCmd.noWorld', { name: wanted }), 'error');
            continue;
          }
          const on = active.includes(name);
          const state = str(args.state);
          if (state === 'off' || (state === 'toggle' && on)) {
            if (on) active.splice(active.indexOf(name), 1);
            if (!silent) ui.toast(t(on ? 'wiCmd.off' : 'wiCmd.wasOff', { name }), on ? 'success' : 'error');
          } else {
            if (!on) active.push(name);
            if (!silent) ui.toast(t('wiCmd.on', { name }), 'success');
          }
        }
        settings.update('worldinfo', { globalBooks: active });
        return '';
      },
    })
    .add({
      name: 'getchatbook',
      aliases: ['getchatlore', 'getchatwi'],
      helpString:
        'Get a name of the chat-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
      namedArgumentList: [
        {
          name: 'name',
          description: 'lorebook name if creating a new one, will be auto-generated otherwise',
        },
        {
          name: 'create',
          description: "create a new lorebook if it doesn't exist",
          typeList: [ArgType.BOOLEAN],
        },
      ],
      callback: async (args) => {
        if (!chat.chat) {
          ui.toast(t('wiCmd.needChat'), 'warning');
          return '';
        }
        const bound = str(chat.chat.metadata.world_info);
        if (bound && bookInfo(bound)) return bound;
        if (isFalseBoolean(str(args.create))) return '';
        const name = await createBook(args.name, bookFileName(`Chat Book ${chat.chat.title}`));
        await chat.updateMetadata({ world_info: name });
        return name;
      },
    })
    .add({
      name: 'getglobalbooks',
      aliases: ['getgloballore', 'getglobalwi'],
      helpString: 'Get a list of names of the selected global lorebooks and pass it down the pipe.',
      callback: () => JSON.stringify(settings.get('worldinfo', worldInfoDefaults).globalBooks),
    })
    .add({
      name: 'getpersonabook',
      aliases: ['getpersonalore', 'getpersonawi'],
      helpString:
        'Get a name of the current persona-bound lorebook and pass it down the pipe. Returns empty string if persona lorebook is not set.',
      namedArgumentList: [
        {
          name: 'name',
          description: 'lorebook name if creating a new one, will be auto-generated otherwise',
        },
        {
          name: 'create',
          description: "create a new lorebook if it doesn't exist",
          typeList: [ArgType.BOOLEAN],
        },
      ],
      callback: async (args) => {
        const persona = chat.persona;
        if (persona?.lorebook) return persona.lorebook;
        if (!persona || !isTrueBoolean(str(args.create))) return '';
        const name = await createBook(args.name, bookFileName(`Persona Book ${chat.userName}`));
        const {
          id,
          rev,
          avatar: _a,
          isDefault: _d,
          sourceFile: _s,
          createdAt: _c,
          updatedAt: _u,
          ...fields
        } = persona;
        const updated = await api.updatePersona(id, { ...fields, lorebook: name }, rev);
        library.personas = library.personas.map((p) => (p.id === id ? updated : p));
        return name;
      },
    })
    .add({
      name: 'getcharbook',
      aliases: ['getcharlore', 'getcharwi'],
      helpString:
        'Get a name of the character-bound lorebook and pass it down the pipe. Returns empty string if character lorebook is not set. Does not work in group chats without providing a character avatar name.',
      namedArgumentList: [
        {
          name: 'type',
          description: 'type of the lorebook to get',
          defaultValue: 'primary',
          enumList: ['primary', 'additional', 'all'],
        },
        {
          name: 'name',
          description: 'lorebook name if creating a new one, will be auto-generated otherwise',
        },
        {
          name: 'create',
          description: "create a new lorebook if it doesn't exist",
          typeList: [ArgType.BOOLEAN],
        },
      ],
      unnamedArgumentList: [{ description: 'Character name - or unique character identifier (avatar key)' }],
      callback: async (args, value) => {
        if (chat.group && !value)
          throw new Error('This command is not available in groups without providing a character name');
        const type = str(args.type).trim().toLowerCase() || 'primary';
        const identifier = str(value) || (chat.character ? avatarKey(chat.character) : '');
        const summary = identifier ? findCharacter(identifier) : null;
        if (!summary) {
          ui.toast(t('wiCmd.noCharacter'), 'error');
          return '';
        }
        const character = await api.getCharacter(summary.id);
        const world = str(
          (character.card as { data?: { extensions?: { world?: unknown } } }).data?.extensions?.world,
        );
        const books: string[] = [];
        if (type === 'all' || (type === 'primary' && world)) books.push(world);
        if (type === 'all' || type === 'additional') {
          books.push(...(settings.get('worldinfo', worldInfoDefaults).characterExtraBooks[summary.id] ?? []));
        }
        if (isTrueBoolean(str(args.create)) && books.length === 0) {
          const name = await createBook(args.name, bookFileName(`Character Book ${summary.name}`));
          if (type === 'additional') {
            const prefs = settings.get('worldinfo', worldInfoDefaults);
            settings.update('worldinfo', {
              characterExtraBooks: {
                ...prefs.characterExtraBooks,
                [summary.id]: [...(prefs.characterExtraBooks[summary.id] ?? []), name],
              },
            });
          } else if (chat.character?.id === summary.id) {
            await chat.updateCard((card) => {
              const data = (card.data ??= {});
              data.extensions = { ...(data.extensions as Record<string, unknown> | undefined), world: name };
            });
          }
          books.push(name);
        }
        const unique = [...new Set(books)].filter(Boolean);
        return type === 'primary' ? (books[0] ?? '') : JSON.stringify(unique);
      },
    })
    .add({
      name: 'findentry',
      aliases: ['findlore', 'findwi'],
      helpString:
        'Find a UID of the record from the specified book using the fuzzy match of a field value (default: key) and pass it down the pipe.',
      namedArgumentList: [
        { name: 'file', description: 'book name', isRequired: true },
        { name: 'field', description: 'field value for fuzzy match (default: key)', defaultValue: 'key' },
      ],
      unnamedArgumentList: [{ description: 'texts', isRequired: true }],
      callback: async (args, value) => {
        const found = await entriesOf(args.file);
        if (!found) return '';
        const field = str(args.field) || 'key';
        let query = str(value);
        if (typeof entryTemplate[field] === 'boolean') {
          if (isTrueBoolean(query)) query = 'true';
          if (isFalseBoolean(query)) query = 'false';
        }
        const [best] = fuzzySearch(found.entries, query, {
          keys: [{ name: field, weight: 1 }],
          includeScore: true,
          threshold: 0.3,
        });
        return best?.uid === undefined ? '' : best.uid;
      },
    })
    .add({
      name: 'getentryfield',
      aliases: ['getlorefield', 'getwifield'],
      helpString:
        'Get a field value (default: content) of the record with the UID from the specified book and pass it down the pipe.',
      namedArgumentList: [
        { name: 'file', description: 'book name', isRequired: true },
        { name: 'field', description: 'field to retrieve (default: content)', defaultValue: 'content' },
      ],
      unnamedArgumentList: [{ description: 'record UID', isRequired: true }],
      callback: async (args, value) => {
        const found = await entriesOf(args.file);
        if (!found) return '';
        const field = str(args.field) || 'content';
        const entry = found.entries.find((e) => String(e.uid) === str(value));
        if (!entry) {
          ui.toast(t('wiCmd.needUid'), 'warning');
          return '';
        }
        if (!isEntryField(field)) {
          ui.toast(t('wiCmd.needField'), 'warning');
          return '';
        }
        let fieldValue: unknown;
        const filter = entry.characterFilter;
        switch (field) {
          case 'characterFilterNames':
            if (filter) fieldValue = filter.names;
            break;
          case 'characterFilterTags':
            if (filter) {
              if (!filter.tags) return '';
              fieldValue = library.tags.filter((tag) => filter.tags.includes(tag.id)).map((tag) => tag.name);
            }
            break;
          case 'characterFilterExclude':
            if (filter) fieldValue = filter.isExclude;
            break;
          default:
            fieldValue = entry[field] ?? fieldDefault(field);
        }
        if (fieldValue === undefined) return '';
        if (Array.isArray(fieldValue)) return JSON.stringify(fieldValue.map((x) => expand(String(x))));
        return expand(String(fieldValue));
      },
    })
    .add({
      name: 'createentry',
      aliases: ['createlore', 'createwi'],
      helpString:
        'Create a new record in the specified book with the key and content (both are optional) and pass the UID down the pipe.',
      namedArgumentList: [
        { name: 'file', description: 'book name', isRequired: true },
        { name: 'key', description: 'record key' },
      ],
      unnamedArgumentList: [{ description: 'content' }],
      callback: async (args, value) => {
        const info = bookInfo(args.file);
        if (!info) {
          ui.toast(t('wiCmd.needBook'), 'warning');
          return '';
        }
        const book = await api.getLorebook(info.id);
        const used = new Set(book.entries.map((e) => Number(e.uid)));
        let uid = 0;
        while (used.has(uid)) uid++;
        const entry = { uid, ...structuredClone(entryTemplate) } as WorldInfoEntry;
        const key = str(args.key);
        if (key) {
          entry.key.push(key);
          entry.addMemo = true;
          entry.comment = key;
        }
        const content = str(value);
        if (content) entry.content = content;
        await saveEntry(book, entry);
        return String(uid);
      },
    })
    .add({
      name: 'setentryfield',
      aliases: ['setlorefield', 'setwifield'],
      helpString:
        'Set a field value (default: content) of the record with the UID from the specified book. To set multiple values for key fields, use comma-delimited list as a value.',
      namedArgumentList: [
        { name: 'file', description: 'book name', isRequired: true },
        { name: 'uid', description: 'record UID', isRequired: true },
        { name: 'field', description: 'field name (default: content)', defaultValue: 'content' },
      ],
      unnamedArgumentList: [{ description: 'value', isRequired: true }],
      callback: async (args, value) => {
        if (value === undefined) {
          ui.toast(t('wiCmd.needValue'), 'warning');
          return '';
        }
        const text = str(value).replace(/\\([{}|])/g, '$1');
        const info = bookInfo(args.file);
        if (!info) {
          ui.toast(t('wiCmd.needBook'), 'warning');
          return '';
        }
        const book = await api.getLorebook(info.id);
        const entry = book.entries.find((e) => String(e.uid) === str(args.uid)) as WorldInfoEntry | undefined;
        if (!entry) {
          ui.toast(t('wiCmd.needUid'), 'warning');
          return '';
        }
        const field = str(args.field) || 'content';
        if (!isEntryField(field)) {
          ui.toast(t('wiCmd.needField'), 'warning');
          return '';
        }
        if (!Object.hasOwn(entry, field)) entry[field] = fieldDefault(field);
        const filter = () => (entry.characterFilter ??= { isExclude: false, names: [], tags: [] });
        switch (field) {
          case 'characterFilterNames':
            filter().names = [
              ...new Set(
                parseStringArray(text)
                  .map((name) => findCharacter(name, false))
                  .filter((c) => c !== null)
                  .map((c) => characterKey(c)),
              ),
            ];
            break;
          case 'characterFilterTags': {
            const names = parseStringArray(text);
            filter().tags = library.tags.filter((tag) => names.includes(tag.name)).map((tag) => tag.id);
            break;
          }
          case 'characterFilterExclude':
            filter().isExclude = isTrueBoolean(text);
            break;
          default: {
            const current = entry[field];
            if (Array.isArray(current)) {
              const list = parseStringArray(text);
              entry[field] =
                field === 'triggers'
                  ? list.filter((x) => (GENERATION_TRIGGERS as readonly string[]).includes(x))
                  : list;
            } else if (typeof current === 'boolean') {
              entry[field] = isTrueBoolean(text);
            } else if (typeof current === 'number') {
              entry[field] = Number(text);
            } else {
              entry[field] = text;
            }
          }
        }
        delete entry.characterFilterNames;
        delete entry.characterFilterTags;
        delete entry.characterFilterExclude;
        await saveEntry(book, entry);
        return '';
      },
    })
    .add({
      name: 'wi-set-timed-effect',
      helpString:
        'Set a timed effect for the record with the UID from the specified book. The duration must be set in the entry itself. Will only be applied for the current chat.',
      namedArgumentList: [
        { name: 'file', description: 'book name', isRequired: true },
        { name: 'uid', description: 'record UID', isRequired: true },
        { name: 'effect', description: 'effect name', isRequired: true, enumList: ['sticky', 'cooldown'] },
      ],
      unnamedArgumentList: [{ description: 'new state of the effect', isRequired: true }],
      callback: async (args, value) => {
        if (!chat.chat) throw new Error('This command can only be used in chat');
        if (value === undefined) {
          ui.toast(t('wiCmd.needState'), 'warning');
          return '';
        }
        const found = await entriesOf(args.file);
        if (!found) return '';
        const entry = found.entries.find((e) => String(e.uid) === str(args.uid));
        if (!entry) {
          ui.toast(t('wiCmd.needUid'), 'warning');
          return '';
        }
        const effect = str(args.effect).trim().toLowerCase();
        if (!TIMED_EFFECTS.includes(effect)) {
          ui.toast(t('wiCmd.needEffect'), 'warning');
          return '';
        }
        if (!entry[effect]) {
          ui.toast(t('wiCmd.noEffect'), 'warning');
          return '';
        }
        const state = timedState();
        const key = `${str(args.file)}.${entry.uid}`;
        const current = !!state[effect]?.[key];
        const wanted = str(value).trim().toLowerCase();
        const next = ['toggle', 't', ''].includes(wanted)
          ? !current
          : isTrueBoolean(wanted)
            ? true
            : isFalseBoolean(wanted)
              ? false
              : current;
        const map = (state[effect] ??= {});
        delete map[key];
        if (next) {
          // SillyTavern sets it from the book file, whose entries carry no scan hash.
          const length = scanLength();
          map[key] = { start: length, end: length + Number(entry[effect]), protected: false } as TimedEffect;
        }
        await chat.updateMetadata({ timedWorldInfo: state });
        ui.toast(t(next ? 'wiCmd.effectOn' : 'wiCmd.effectOff', { effect, uid: entry.uid }), 'success');
        return '';
      },
    })
    .add({
      name: 'wi-get-timed-effect',
      helpString:
        'Get the current state of the timed effect for the record with the UID from the specified book.',
      namedArgumentList: [
        { name: 'file', description: 'book name', isRequired: true },
        { name: 'effect', description: 'effect name', isRequired: true, enumList: ['sticky', 'cooldown'] },
        {
          name: 'format',
          description: 'output format',
          isRequired: true,
          defaultValue: 'bool',
          enumList: ['bool', 'number'],
        },
      ],
      unnamedArgumentList: [{ description: 'record UID', isRequired: true }],
      callback: async (args, value) => {
        if (!chat.chat) throw new Error('This command can only be used in chat');
        const found = await entriesOf(args.file);
        if (!found) return '';
        const entry = found.entries.find((e) => String(e.uid) === str(value));
        if (!entry) {
          ui.toast(t('wiCmd.needUid'), 'warning');
          return '';
        }
        const effect = str(args.effect).trim().toLowerCase();
        if (!TIMED_EFFECTS.includes(effect)) {
          ui.toast(t('wiCmd.needEffect'), 'warning');
          return '';
        }
        const data = timedState()[effect]?.[`${str(args.file)}.${entry.uid}`];
        if (str(args.format).trim().toLowerCase() === 'number') {
          return String(data ? data.end - scanLength() : 0);
        }
        return String(!!data);
      },
    });
}

addCommands(registerWorldInfoCommands);
