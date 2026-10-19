/** Quick Reply commands (SillyTavern's Quick Reply extension: `/qr-*`, `/qr-arg`, `/import`). */

import { ArgType, Closure, isTrueBoolean, type NamedArguments, type Stscript } from '@bakatavern/core';

import { t } from '../../i18n/index.svelte.ts';
import { ui } from '../../state/ui.svelte.ts';
import {
  newQuickReply,
  newQuickReplySet,
  quickReplies,
  type QuickReply,
  type QuickReplySet,
  type SetLink,
} from '../../quickreplies/store.svelte.ts';
import { addCommands } from '../runtime.svelte.ts';

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const bool = (value: unknown) => isTrueBoolean(str(value));
const flag = (value: unknown) => (value === undefined ? undefined : bool(value));

/** Reports a failure as a toast, like SillyTavern's Quick Reply commands. */
async function reported<T>(run: () => T | Promise<T>): Promise<T | ''> {
  try {
    return await run();
  } catch (error) {
    ui.toast((error as Error).message, 'error');
    return '';
  }
}

function needSet(name: string): QuickReplySet {
  const set = quickReplies.set(name);
  if (!set) throw new Error(t('qr.noSet', { name }));
  // A plain copy to change and save.
  return JSON.parse(JSON.stringify(set)) as QuickReplySet;
}

function findReply(set: QuickReplySet, args: NamedArguments, fallback?: unknown): QuickReply {
  const id = args.id !== undefined ? Number(args.id) : undefined;
  const label = str(args.label ?? fallback);
  const qr =
    id !== undefined ? set.qrList.find((q) => q.id === id) : set.qrList.find((q) => q.label === label);
  if (!qr) throw new Error(t('qr.noReply', { label: id ?? label, set: set.name }));
  return qr;
}

/** Turns a set on (or off, when it is linked already) in a list of links. */
function toggled(list: SetLink[], name: string, visible: boolean, mode: 'toggle' | 'on' | 'off'): SetLink[] {
  const has = list.some((l) => l.set === name);
  if (mode === 'off' || (mode === 'toggle' && has)) return list.filter((l) => l.set !== name);
  if (has) return list;
  return [...list, { set: name, isVisible: visible }];
}

const autoArgs = [
  { name: 'hidden', description: 'hide the button', typeList: [ArgType.BOOLEAN] },
  { name: 'startup', description: 'auto execute on app startup', typeList: [ArgType.BOOLEAN] },
  { name: 'user', description: 'auto execute on user message', typeList: [ArgType.BOOLEAN] },
  { name: 'bot', description: 'auto execute on AI message', typeList: [ArgType.BOOLEAN] },
  { name: 'load', description: 'auto execute on chat load', typeList: [ArgType.BOOLEAN] },
  { name: 'new', description: 'auto execute on new chat', typeList: [ArgType.BOOLEAN] },
  { name: 'group', description: 'auto execute on group member selection', typeList: [ArgType.BOOLEAN] },
  { name: 'generation', description: 'auto execute before a generation', typeList: [ArgType.BOOLEAN] },
  { name: 'title', description: 'title / tooltip to be shown on button' },
  { name: 'automationId', description: 'runs when World Info entries with this automation id activate' },
];
const setArg = { name: 'set', description: 'name of the QR set', isRequired: true };
const labelArg = { name: 'label', description: 'text on the button' };
const idArg = { name: 'id', description: 'numeric ID of the QR', typeList: [ArgType.NUMBER] };

export function registerQuickReplyCommands(st: Stscript) {
  const visibleArg = {
    name: 'visible',
    description: 'set visibility',
    typeList: [ArgType.BOOLEAN],
    defaultValue: 'true',
  };
  const setNameArg = { description: 'QR set name', isRequired: true };
  const globalToggle = (mode: 'toggle' | 'on' | 'off') => (args: NamedArguments, value: unknown) =>
    reported(() => {
      const name = str(value);
      needSet(name);
      quickReplies.setGlobalLinks(
        toggled(quickReplies.globalLinks, name, bool(args.visible ?? 'true'), mode),
      );
      return '';
    });
  const chatToggle = (mode: 'toggle' | 'on' | 'off') => (args: NamedArguments, value: unknown) =>
    reported(async () => {
      const name = str(value);
      needSet(name);
      await quickReplies.setChatLinks(
        toggled(quickReplies.chatLinks, name, bool(args.visible ?? 'true'), mode),
      );
      return '';
    });

  st.commands
    .add({
      name: 'qr',
      helpString: 'Runs the Quick Reply with the given index (from 0) among the active sets.',
      unnamedArgumentList: [{ description: 'number', typeList: [ArgType.NUMBER], isRequired: true }],
      callback: (_, value) =>
        reported(async () => {
          const all = quickReplies.activeLinks.flatMap((l) => {
            const set = quickReplies.set(l.set)!;
            return set.qrList.map((qr) => ({ set, qr }));
          });
          const found = all[Number(value)];
          if (!found) throw new Error(t('qr.noIndex', { index: str(value) }));
          return quickReplies.execute(found.set, found.qr);
        }),
    })
    .add({
      name: 'qrset',
      helpString: 'Deprecated: use /qr-set, /qr-set-on and /qr-set-off.',
      callback: () => {
        ui.toast(t('qr.deprecated'), 'warning');
        return '';
      },
    })
    .add({
      name: 'qr-set',
      helpString: 'Toggles a global Quick Reply set.',
      namedArgumentList: [visibleArg],
      unnamedArgumentList: [setNameArg],
      callback: globalToggle('toggle'),
    })
    .add({
      name: 'qr-set-on',
      helpString: 'Activates a global Quick Reply set.',
      namedArgumentList: [visibleArg],
      unnamedArgumentList: [setNameArg],
      callback: globalToggle('on'),
    })
    .add({
      name: 'qr-set-off',
      helpString: 'Deactivates a global Quick Reply set.',
      unnamedArgumentList: [setNameArg],
      callback: globalToggle('off'),
    })
    .add({
      name: 'qr-chat-set',
      helpString: 'Toggles a Quick Reply set for this chat.',
      namedArgumentList: [visibleArg],
      unnamedArgumentList: [setNameArg],
      callback: chatToggle('toggle'),
    })
    .add({
      name: 'qr-chat-set-on',
      helpString: 'Activates a Quick Reply set for this chat.',
      namedArgumentList: [visibleArg],
      unnamedArgumentList: [setNameArg],
      callback: chatToggle('on'),
    })
    .add({
      name: 'qr-chat-set-off',
      helpString: 'Deactivates a Quick Reply set for this chat.',
      unnamedArgumentList: [setNameArg],
      callback: chatToggle('off'),
    })
    .add({
      name: 'qr-set-list',
      helpString: 'Gets a list of the names of all Quick Reply sets (or the global or chat ones).',
      unnamedArgumentList: [
        { description: 'set type', enumList: ['all', 'global', 'chat'], defaultValue: 'all' },
      ],
      callback: (_, value) => {
        const source = str(value) || 'all';
        const names =
          source === 'global'
            ? quickReplies.globalLinks.map((l) => l.set)
            : source === 'chat'
              ? quickReplies.chatLinks.map((l) => l.set)
              : quickReplies.infos.map((p) => p.name);
        return JSON.stringify(names);
      },
    })
    .add({
      name: 'qr-list',
      helpString: 'Gets a list of the labels of all Quick Replies in a set.',
      unnamedArgumentList: [setNameArg],
      callback: (_, value) => reported(() => JSON.stringify(needSet(str(value)).qrList.map((q) => q.label))),
    })
    .add({
      name: 'qr-create',
      helpString: 'Creates a new Quick Reply.',
      namedArgumentList: [setArg, { ...labelArg, isRequired: true }, ...autoArgs],
      unnamedArgumentList: [{ description: 'message', isRequired: true }],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.set));
          const id = Math.max(set.idIndex, ...set.qrList.map((q) => q.id), 0) + 1;
          set.idIndex = id + 1;
          set.qrList.push(
            newQuickReply(id, {
              label: str(args.label),
              icon: args.icon !== undefined ? str(args.icon) : '',
              showLabel: flag(args.showlabel) ?? false,
              message: str(value),
              title: str(args.title),
              isHidden: bool(args.hidden),
              executeOnStartup: bool(args.startup),
              executeOnUser: bool(args.user),
              executeOnAi: bool(args.bot),
              executeOnChatChange: bool(args.load),
              executeOnNewChat: bool(args.new),
              executeOnGroupMemberDraft: bool(args.group),
              executeBeforeGeneration: bool(args.generation),
              automationId: str(args.automationId),
            }),
          );
          await quickReplies.save(set);
          return '';
        }),
    })
    .add({
      name: 'qr-get',
      helpString: 'Gets a Quick Reply as JSON.',
      namedArgumentList: [setArg, labelArg, idArg],
      callback: (args) =>
        reported(() => {
          if (args.id === undefined && !args.label) throw new Error(t('qr.needLabel'));
          return JSON.stringify(findReply(needSet(str(args.set)), args));
        }),
    })
    .add({
      name: 'qr-update',
      helpString: 'Updates a Quick Reply.',
      namedArgumentList: [
        setArg,
        labelArg,
        idArg,
        { name: 'newlabel', description: 'new text for the button' },
        ...autoArgs,
      ],
      unnamedArgumentList: [{ description: 'message' }],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.set));
          const qr = findReply(set, args);
          const set_ = <K extends keyof QuickReply>(key: K, v: QuickReply[K] | undefined) => {
            if (v !== undefined) qr[key] = v;
          };
          set_('icon', args.icon !== undefined ? str(args.icon) : undefined);
          set_('showLabel', flag(args.showlabel));
          set_('label', args.newlabel !== undefined ? str(args.newlabel) : undefined);
          set_('message', str(value).trim().length > 0 ? str(value) : undefined);
          set_('title', args.title !== undefined ? str(args.title) : undefined);
          set_('isHidden', flag(args.hidden));
          set_('executeOnStartup', flag(args.startup));
          set_('executeOnUser', flag(args.user));
          set_('executeOnAi', flag(args.bot));
          set_('executeOnChatChange', flag(args.load));
          set_('executeOnGroupMemberDraft', flag(args.group));
          set_('executeOnNewChat', flag(args.new));
          set_('executeBeforeGeneration', flag(args.generation));
          qr.automationId = str(args.automationId);
          await quickReplies.save(set);
          return '';
        }),
    })
    .add({
      name: 'qr-delete',
      helpString: 'Deletes a Quick Reply.',
      namedArgumentList: [setArg, labelArg, idArg],
      unnamedArgumentList: [{ description: 'label' }],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.set));
          const qr = findReply(set, args, value);
          set.qrList = set.qrList.filter((q) => q.id !== qr.id);
          await quickReplies.save(set);
          return '';
        }),
    })
    .add({
      name: 'qr-contextadd',
      helpString: "Adds a set to a Quick Reply's context menu.",
      namedArgumentList: [
        setArg,
        labelArg,
        idArg,
        {
          name: 'chain',
          description: 'run the reply before the menu item',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [setNameArg],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.set));
          const qr = findReply(set, args);
          qr.contextList = [
            ...qr.contextList.filter((c) => c.set !== str(value)),
            { set: str(value), isChained: bool(args.chain) },
          ];
          await quickReplies.save(set);
          return '';
        }),
    })
    .add({
      name: 'qr-contextdel',
      helpString: "Removes a set from a Quick Reply's context menu.",
      namedArgumentList: [setArg, labelArg, idArg],
      unnamedArgumentList: [setNameArg],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.set));
          const qr = findReply(set, args);
          qr.contextList = qr.contextList.filter((c) => c.set !== str(value));
          await quickReplies.save(set);
          return '';
        }),
    })
    .add({
      name: 'qr-contextclear',
      helpString: "Removes every set from a Quick Reply's context menu.",
      namedArgumentList: [setArg, idArg],
      unnamedArgumentList: [{ description: 'Quick Reply label' }],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.set));
          findReply(set, args, value).contextList = [];
          await quickReplies.save(set);
          return '';
        }),
    });

  const setOptions = [
    {
      name: 'nosend',
      description: 'disable send / insert in user input (invalid for slash commands)',
      typeList: [ArgType.BOOLEAN],
    },
    { name: 'before', description: 'place QR before user input', typeList: [ArgType.BOOLEAN] },
    {
      name: 'inject',
      description: 'inject user input automatically (if disabled use {{input}})',
      typeList: [ArgType.BOOLEAN],
    },
  ];
  st.commands
    .add({
      name: 'qr-set-create',
      aliases: ['qr-presetadd'],
      helpString: 'Creates a new Quick Reply set.',
      namedArgumentList: setOptions,
      unnamedArgumentList: [{ description: 'name', isRequired: true }],
      callback: (args, value) =>
        reported(async () => {
          const name = str(args.name ?? value);
          if (!name) throw new Error(t('qr.needName'));
          if (quickReplies.set(name)) throw new Error(t('qr.setExists', { name }));
          await quickReplies.save({
            ...newQuickReplySet(name),
            disableSend: bool(args.nosend),
            placeBeforeInput: bool(args.before),
            injectInput: bool(args.inject),
          });
          return '';
        }),
    })
    .add({
      name: 'qr-set-update',
      aliases: ['qr-presetupdate'],
      helpString: 'Updates a Quick Reply set.',
      namedArgumentList: setOptions,
      unnamedArgumentList: [{ description: 'name', isRequired: true }],
      callback: (args, value) =>
        reported(async () => {
          const set = needSet(str(args.name ?? value));
          if (args.nosend !== undefined) set.disableSend = bool(args.nosend);
          if (args.before !== undefined) set.placeBeforeInput = bool(args.before);
          if (args.inject !== undefined) set.injectInput = bool(args.inject);
          await quickReplies.save(set);
          return '';
        }),
    })
    .add({
      name: 'qr-set-delete',
      aliases: ['qr-presetdelete'],
      helpString: 'Deletes a Quick Reply set.',
      unnamedArgumentList: [{ description: 'name', isRequired: true }],
      callback: (_, value) =>
        reported(async () => {
          needSet(str(value));
          await quickReplies.remove(str(value));
          return '';
        }),
    })
    .add({
      name: 'qr-arg',
      helpString: 'Sets a fallback value for a Quick Reply argument ({{arg::name}}).',
      unnamedArgumentList: [
        { description: 'argument name', isRequired: true },
        { description: 'argument value', isRequired: true },
      ],
      splitUnnamedArgument: true,
      splitUnnamedArgumentCount: 2,
      callback: (args, value) => {
        const [key, val] = Array.isArray(value) ? value : [value];
        args._scope.setMacro(`arg::${str(key)}`, val as string, str(key).includes('*'));
        return '';
      },
    })
    .add({
      name: 'import',
      helpString: 'Imports closures stored in scoped variables of another Quick Reply.',
      namedArgumentList: [
        {
          name: 'from',
          description: 'name of the Quick Reply to import from (Set.Label or a label)',
          isRequired: true,
        },
      ],
      unnamedArgumentList: [
        { description: 'variable names, "name as other" to rename', isRequired: true, acceptsMultiple: true },
      ],
      splitUnnamedArgument: true,
      callback: (args, value) => {
        const from = str(args.from);
        if (!from) throw new Error('/import requires from= to be set.');
        if (!value) throw new Error('/import requires the unnamed argument to be set.');
        let qr = quickReplies.activeLinks
          .flatMap((l) => quickReplies.set(l.set)!.qrList)
          .find((q) => q.label === from);
        if (!qr) {
          const [setName, ...rest] = from.split('.');
          qr = quickReplies.set(setName ?? '')?.qrList.find((q) => q.label === rest.join('.'));
        }
        if (!qr) throw new Error(`No Quick Reply found for "${from}".`);
        const closure = st.parser().parse(qr.message, true, [], args._abortController);
        // Closures assigned with /let or /var: `/let name {: ... :}` or `/let key=name {: ... :}`.
        const candidates = closure.executorList
          .filter((e) => ['let', 'var'].includes(e.command?.name ?? ''))
          .flatMap((e) => {
            const key = e.namedArgumentList.find((a) => a.name === 'key');
            const value = e.unnamedArgumentList[key ? 0 : 1]?.value;
            if (!(value instanceof Closure)) return [];
            return [{ key: str(key ? key.value : e.unnamedArgumentList[0]?.value), value }];
          });
        const names = (Array.isArray(value) ? value : [value]).map(str);
        for (let i = 0; i < names.length; i++) {
          const source = names[i]!;
          let target = source;
          if (i + 2 < names.length && names[i + 1] === 'as') {
            target = names[i + 2]!;
            i += 2;
          }
          const pick = candidates.find((c) => c.key === source);
          if (!pick) throw new Error(`No scoped closure named "${source}" found in "${from}"`);
          if (args._scope.existsVariableInScope(target)) args._scope.setVariable(target, pick.value);
          else args._scope.letVariable(target, pick.value);
        }
        return '';
      },
    });
}

addCommands(registerQuickReplyCommands);
