/**
 * Quick Replies (SillyTavern's Quick Reply extension, v2): sets of buttons that send text or run
 * scripts. Sets are stored as presets of kind `qr` in SillyTavern's file format; which sets show
 * is configured globally, per chat (`chat_metadata.quickReply`) and per character.
 */

import type { PresetInfo } from '@bakatavern/api-client';
import { Scope, type ClosureResult, type ExecuteOptions } from '@bakatavern/core';

import { api } from '../api.ts';
import { events, eventTypes } from '../events.ts';
import { macros } from '../generation/pipeline.ts';
import { t } from '../i18n/index.svelte.ts';
import { chat } from '../state/chat.svelte.ts';
import { library } from '../state/library.svelte.ts';
import { quickReplyDefaults, type QuickReplyPrefs, type SetLink } from '../state/prefs.ts';
import { settings } from '../state/settings.svelte.ts';
import { errorText, ui } from '../state/ui.svelte.ts';
import { scripts, setQuickReplyRunner } from '../stscript/runtime.svelte.ts';

export const QR_KIND = 'qr';

export { quickReplyDefaults, type QuickReplyPrefs, type SetLink };

export interface QuickReplyLink {
  set: string;
  isChained: boolean;
}

export interface QuickReply {
  id: number;
  icon?: string;
  showLabel?: boolean;
  label: string;
  title: string;
  message: string;
  contextList: QuickReplyLink[];
  preventAutoExecute: boolean;
  isHidden: boolean;
  executeOnStartup: boolean;
  executeOnUser: boolean;
  executeOnAi: boolean;
  executeOnChatChange: boolean;
  executeOnGroupMemberDraft: boolean;
  executeOnNewChat: boolean;
  executeBeforeGeneration: boolean;
  automationId: string;
  [extra: string]: unknown;
}

export interface QuickReplySet {
  version: number;
  name: string;
  /** The text goes into the message box instead of being sent. */
  disableSend: boolean;
  /** With `injectInput`: the reply goes before what was typed. */
  placeBeforeInput: boolean;
  /** Combine with what is in the message box. */
  injectInput: boolean;
  color: string;
  onlyBorderColor: boolean;
  qrList: QuickReply[];
  idIndex: number;
  [extra: string]: unknown;
}

export type AutoEvent =
  | 'executeOnStartup'
  | 'executeOnUser'
  | 'executeOnAi'
  | 'executeOnChatChange'
  | 'executeOnGroupMemberDraft'
  | 'executeOnNewChat'
  | 'executeBeforeGeneration';

export function newQuickReply(id: number, fields: Partial<QuickReply> = {}): QuickReply {
  return {
    id,
    icon: '',
    showLabel: false,
    label: '',
    title: '',
    message: '',
    contextList: [],
    preventAutoExecute: true,
    isHidden: false,
    executeOnStartup: false,
    executeOnUser: false,
    executeOnAi: false,
    executeOnChatChange: false,
    executeOnGroupMemberDraft: false,
    executeOnNewChat: false,
    executeBeforeGeneration: false,
    automationId: '',
    ...fields,
  };
}

export function newQuickReplySet(name: string): QuickReplySet {
  return {
    version: 2,
    name,
    disableSend: false,
    placeBeforeInput: false,
    injectInput: false,
    color: 'transparent',
    onlyBorderColor: false,
    qrList: [],
    idIndex: 0,
  };
}

/** A stored set with every field SillyTavern writes. */
export function normalizeSet(data: Record<string, unknown>, name: string): QuickReplySet {
  const base = newQuickReplySet(name);
  const qrList = Array.isArray(data.qrList) ? data.qrList : [];
  return {
    ...base,
    ...data,
    name,
    qrList: qrList.map((qr, i) => {
      const q = (qr ?? {}) as Partial<QuickReply>;
      return newQuickReply(typeof q.id === 'number' ? q.id : i + 1, {
        ...q,
        contextList: Array.isArray(q.contextList)
          ? q.contextList.map((c) => ({
              set:
                typeof c?.set === 'string'
                  ? c.set
                  : String((c as { set?: { name?: string } })?.set?.name ?? ''),
              isChained: Boolean(c?.isChained),
            }))
          : [],
      });
    }),
  } as QuickReplySet;
}

class QuickReplies {
  /** Loaded sets by name. */
  sets = $state<Record<string, QuickReplySet>>({});
  #revs = new Map<string, number>();
  /** Auto-executed replies may forbid others from running inside them. */
  #preventStack: boolean[] = [];

  get prefs(): QuickReplyPrefs {
    return { ...quickReplyDefaults, ...settings.get('quickReply', quickReplyDefaults) };
  }

  updatePrefs(patch: Partial<QuickReplyPrefs>) {
    settings.update('quickReply', patch);
  }

  get infos(): PresetInfo[] {
    return library.presets.filter((p) => p.kind === QR_KIND).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Loads the sets that are new or changed. */
  async load() {
    const infos = this.infos;
    const names = new Set(infos.map((p) => p.name));
    for (const name of Object.keys(this.sets)) if (!names.has(name)) delete this.sets[name];
    await Promise.all(
      infos
        .filter((p) => this.#revs.get(p.id) !== p.rev)
        .map(async (p) => {
          const preset = await api.getPreset(p.id);
          this.#revs.set(p.id, preset.rev);
          this.sets[p.name] = normalizeSet(preset.data, p.name);
        }),
    );
  }

  set(name: string): QuickReplySet | undefined {
    return this.sets[name];
  }

  async save(set: QuickReplySet) {
    const saved = await api.upsertPreset(
      QR_KIND,
      set.name,
      $state.snapshot(set) as unknown as Record<string, unknown>,
    );
    this.#revs.set(saved.id, saved.rev);
    this.sets[set.name] = normalizeSet(saved.data, set.name);
    await library.refreshPresets();
  }

  async remove(name: string) {
    const info = this.infos.find((p) => p.name === name);
    if (info) await api.deletePreset(info.id);
    delete this.sets[name];
    await library.refreshPresets();
  }

  async rename(oldName: string, newName: string) {
    const set = this.sets[oldName];
    if (!set || !newName.trim() || this.sets[newName]) return;
    await this.save({ ...$state.snapshot(set), name: newName } as QuickReplySet);
    await this.remove(oldName);
    // Links to it follow.
    const relink = (list: SetLink[]) => list.map((l) => (l.set === oldName ? { ...l, set: newName } : l));
    const prefs = this.prefs;
    this.updatePrefs({
      config: { setList: relink(prefs.config.setList) },
      characterConfigs: Object.fromEntries(
        Object.entries(prefs.characterConfigs).map(([id, c]) => [id, { setList: relink(c.setList) }]),
      ),
    });
    if (this.chatLinks.some((l) => l.set === oldName)) await this.setChatLinks(relink(this.chatLinks));
  }

  // Which sets show

  get globalLinks(): SetLink[] {
    return this.prefs.config.setList;
  }

  get chatLinks(): SetLink[] {
    const config = chat.chat?.metadata.quickReply as { setList?: SetLink[] } | undefined;
    return Array.isArray(config?.setList) ? config.setList : [];
  }

  get characterLinks(): SetLink[] {
    return chat.characterId ? (this.prefs.characterConfigs[chat.characterId]?.setList ?? []) : [];
  }

  setGlobalLinks(setList: SetLink[]) {
    this.updatePrefs({ config: { setList } });
  }

  async setChatLinks(setList: SetLink[]) {
    await chat.updateMetadata({ quickReply: { setList } });
  }

  setCharacterLinks(setList: SetLink[]) {
    if (!chat.characterId) return;
    this.updatePrefs({
      characterConfigs: { ...this.prefs.characterConfigs, [chat.characterId]: { setList } },
    });
  }

  /** Every linked set, global first (SillyTavern's order), each once. */
  get activeLinks(): SetLink[] {
    const all = [...this.globalLinks, ...this.chatLinks, ...this.characterLinks];
    return all.filter(
      (link, i) => this.sets[link.set] && all.findIndex((other) => other.set === link.set) === i,
    );
  }

  /** Sets whose buttons show above the message box. */
  get visibleSets(): QuickReplySet[] {
    if (!this.prefs.isEnabled) return [];
    return this.activeLinks.filter((l) => l.isVisible).map((l) => this.sets[l.set]!);
  }

  // Running

  /**
   * Runs a reply (SillyTavern `executeWithOptions`): a script runs, text is sent (or put into the
   * box when the set says so). `args` become `{{arg::name}}`.
   */
  async execute(
    set: QuickReplySet,
    qr: QuickReply,
    options: {
      args?: Record<string, unknown>;
      isAutoExecute?: boolean;
      isRun?: boolean;
      execution?: ExecuteOptions;
    } = {},
  ): Promise<unknown> {
    if (!qr.message) return undefined;
    const scope = new Scope();
    for (const [key, value] of Object.entries(options.args ?? {})) {
      if (key.startsWith('_') || key === 'isAutoExecute') continue;
      scope.setMacro(`arg::${key}`, value as string);
    }
    scope.setMacro('arg::*', '');
    let input = chat.draft;
    if (!options.isAutoExecute && !options.isRun && set.injectInput && input.length > 0) {
      input = set.placeBeforeInput ? `${qr.message} ${input}` : `${input} ${qr.message}`;
    } else {
      input = `${qr.message} `;
    }
    if (input.startsWith('/') && !set.disableSend) {
      let result: ClosureResult | null;
      if (options.isAutoExecute || options.isRun) {
        result = await scripts.run(input, { ...options.execution, scope, handleParserErrors: true });
      } else {
        result = await scripts.runInput(input, scope);
      }
      return result?.pipe ?? '';
    }
    chat.draft = macros.evaluate(input, chat.macroEnv());
    if (!set.disableSend && !chat.busy) await chat.send(chat.draft);
    return undefined;
  }

  /** `/run name`: a reply by label in the active sets, else `Set.Label`. */
  async runByName(name: string, args: Record<string, unknown>, execution: ExecuteOptions) {
    for (const link of this.activeLinks) {
      const set = this.sets[link.set]!;
      const qr = set.qrList.find((q) => q.label === name);
      if (qr) return this.execute(set, qr, { args, isRun: true, execution });
    }
    const [setName, ...rest] = name.split('.');
    const set = this.sets[setName ?? ''];
    const qr = set?.qrList.find((q) => q.label === rest.join('.'));
    if (set && qr) return this.execute(set, qr, { args, isRun: true, execution });
    throw new Error(t('qr.notFound', { name }));
  }

  /** Runs the replies that run on an event (SillyTavern `AutoExecuteHandler`). */
  async autoExecute(event: AutoEvent | { automationIds: string[] }) {
    if (!this.prefs.isEnabled || this.#preventStack.at(-1)) return;
    const replies = this.activeLinks.flatMap((link) => {
      const set = this.sets[link.set]!;
      const matching =
        typeof event === 'string'
          ? set.qrList.filter((qr) => qr[event])
          : set.qrList.filter((qr) => qr.automationId && event.automationIds.includes(qr.automationId));
      return matching.map((qr) => ({ set, qr }));
    });
    for (const { set, qr } of replies) {
      this.#preventStack.push(qr.preventAutoExecute);
      try {
        await this.execute(set, qr, { isAutoExecute: true, args: { isAutoExecute: true } });
      } catch (error) {
        console.warn('[quick replies]', error);
      } finally {
        this.#preventStack.pop();
      }
    }
  }

  /** A click on a button. */
  async click(set: QuickReplySet, qr: QuickReply) {
    try {
      await this.execute(set, qr);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
}

export const quickReplies = new QuickReplies();

setQuickReplyRunner((name, args, options) => quickReplies.runByName(name, args, options));

// Replies that run by themselves.
events.on(eventTypes.APP_READY, () => quickReplies.autoExecute('executeOnStartup'));
events.on(eventTypes.CHAT_CHANGED, () => quickReplies.autoExecute('executeOnChatChange'));
events.makeFirst(eventTypes.USER_MESSAGE_RENDERED, () => quickReplies.autoExecute('executeOnUser'));
events.makeFirst(eventTypes.CHARACTER_MESSAGE_RENDERED, (index) => {
  // Not for the placeholder of a swipe being written.
  const message = chat.messages[index as number];
  if (message && message.swipes[message.swipeId]?.content === '...') return;
  return quickReplies.autoExecute('executeOnAi');
});
events.on(eventTypes.GROUP_MEMBER_DRAFTED, () => quickReplies.autoExecute('executeOnGroupMemberDraft'));
events.on(eventTypes.CHAT_CREATED, () => quickReplies.autoExecute('executeOnNewChat'));
events.on(eventTypes.GROUP_CHAT_CREATED, () => quickReplies.autoExecute('executeOnNewChat'));
events.on(eventTypes.GENERATION_AFTER_COMMANDS, (_type, _options, dryRun) => {
  if (!dryRun) return quickReplies.autoExecute('executeBeforeGeneration');
});
events.on(eventTypes.WORLD_INFO_ACTIVATED, (entries) => {
  const automationIds = (Array.isArray(entries) ? entries : [])
    .map((e) => (e as { automationId?: string }).automationId)
    .filter((id): id is string => Boolean(id));
  if (automationIds.length) return quickReplies.autoExecute({ automationIds });
});
