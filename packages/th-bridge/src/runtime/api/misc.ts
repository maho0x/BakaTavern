/**
 * The rest of TavernHelper's functions: utilities, characters, personas, slash commands,
 * generation, prompt injections, regex, script buttons, versions, and stubs for what a sandboxed
 * frame cannot do.
 */

import { getRegexedString, RegexPlacement, type RegexScript } from '@bakatavern/core/regex/engine';
import { stringHash } from '@bakatavern/core/util/hash';

import { iframeEvents, type FrameConfig, type ScriptButton } from '../../protocol.ts';
import type { Runtime } from '../context.ts';
import { lastMessageId } from '../state.ts';

/** The TavernHelper release whose functions this implements. */
export const TAVERN_HELPER_VERSION = '4.11.3';
const TAVERN_VERSION = '1.19.0';

const regexSources: Record<string, number> = {
  user_input: RegexPlacement.USER_INPUT,
  ai_output: RegexPlacement.AI_OUTPUT,
  slash_command: RegexPlacement.SLASH_COMMAND,
  world_info: RegexPlacement.WORLD_INFO,
  reasoning: RegexPlacement.REASONING,
};

export function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A script's button event name (`getButtonId`). */
export function buttonEvent(scriptId: string, name: string): string {
  return `${scriptId}_${stringHash(name)}`;
}

function toTavernRegex(script: RegexScript, scope: 'global' | 'character') {
  const placement = script.placement ?? [];
  return {
    id: script.id,
    script_name: script.scriptName,
    enabled: !script.disabled,
    scope,
    find_regex: script.findRegex,
    replace_string: script.replaceString,
    trim_strings: script.trimStrings ?? [],
    source: {
      user_input: placement.includes(RegexPlacement.USER_INPUT),
      ai_output: placement.includes(RegexPlacement.AI_OUTPUT),
      slash_command: placement.includes(RegexPlacement.SLASH_COMMAND),
      world_info: placement.includes(RegexPlacement.WORLD_INFO),
      reasoning: placement.includes(RegexPlacement.REASONING),
    },
    destination: { display: !script.promptOnly, prompt: !script.markdownOnly },
    run_on_edit: script.runOnEdit,
    min_depth: script.minDepth,
    max_depth: script.maxDepth,
  };
}

export function miscApi(
  rt: Runtime,
  config: FrameConfig,
  toastError: (message: string, title: string) => void,
) {
  const { mirror, transport } = rt;

  const scriptId = () => {
    if (!config.scriptId) throw new Error('你只能在脚本 iframe 内获取 getScriptId!');
    return config.scriptId;
  };

  function getMessageId(name: string): number {
    const match = name.match(/^TH-message--(\d+)--\d+(_\d+)?$/);
    if (!match) throw new Error(`获取 ${name} 所在楼层 id 时出错: 不要对全局脚本 iframe 调用 getMessageId!`);
    return parseInt(match[1]!, 10);
  }

  function errorCatched<T extends unknown[], U>(fn: (...args: T) => U): (...args: T) => U {
    const onError = (error: unknown): never => {
      const e = error instanceof Error ? error : new Error(String(error));
      toastError(e.stack ?? e.message, `[${config.name}] ${e.name}`);
      throw e;
    };
    return (...args: T): U => {
      try {
        const result = fn(...args);
        if (result instanceof Promise) return result.catch(onError) as U;
        return result;
      } catch (error) {
        return onError(error);
      }
    };
  }

  // Generation: the page runs it and reports progress as TavernHelper's events.
  async function generate(kind: 'generate' | 'generateRaw', generateConfig: Record<string, unknown> = {}) {
    const id = (generateConfig.generation_id as string | undefined) ?? uuid();
    return transport.call<unknown>(kind, { ...generateConfig, generation_id: id });
  }

  function formatAsTavernRegexedString(
    text: string,
    source: string,
    destination: 'display' | 'prompt',
    options: { depth?: number; character_name?: string } = {},
  ): string {
    const regex = mirror.state.regex;
    const scripts = [
      ...regex.global,
      ...(regex.presetEnabled ? regex.preset : []),
      ...(regex.characterEnabled ? regex.character : []),
    ];
    const placement = regexSources[source];
    if (placement === undefined) return text;
    return getRegexedString(text, placement, scripts, (value) => rt.substitute(value), {
      isMarkdown: destination === 'display',
      isPrompt: destination === 'prompt',
      depth: options.depth,
      characterOverride: options.character_name,
    });
  }

  const buttons = (): ScriptButton[] => mirror.state.scripts[scriptId()]?.buttons ?? [];
  const replaceButtons = (list: ScriptButton[]) => {
    const id = scriptId();
    const script = mirror.state.scripts[id];
    if (script) script.buttons = list;
    transport.notify('replaceScriptButtons', id, list);
  };

  return {
    // util
    substitudeMacros: (text: string) => rt.substitute(text),
    getLastMessageId: () => lastMessageId(mirror.state),
    getMessageId,
    getCurrentMessageId: () => getMessageId(config.name),
    errorCatched,
    getIframeName: () => config.name,
    getScriptId: scriptId,
    reloadIframe: () => window.location.reload(),

    // characters and personas
    getCharData: (name: string = 'current') => {
      const character = mirror.state.character;
      if (!character || (name !== 'current' && name !== character.name && name !== character.avatar))
        return null;
      const data = ((character.card as { data?: Record<string, unknown> }).data ?? {}) as Record<
        string,
        unknown
      >;
      return structuredClone({ ...data, name: character.name, avatar: character.avatar, data });
    },
    getCharAvatarPath: (name: string = 'current') => {
      const character = mirror.state.character;
      if (!character || (name !== 'current' && name !== character.name && name !== character.avatar))
        return null;
      return character.avatarUrl;
    },
    getChatHistoryBrief: async () => [],
    getChatHistoryDetail: async () => null,
    getCharacterNames: () => mirror.state.characters.map((c) => c.name),
    getCharacterIds: () => mirror.state.characters.map((c) => c.avatar),
    getCurrentCharacterName: () => mirror.state.character?.name ?? null,
    getCurrentCharacterId: () => mirror.state.character?.avatar ?? null,
    getPersonaNames: () => [...mirror.state.personas],
    getPersonaIds: () => [...mirror.state.personas],
    getCurrentPersonaName: () => mirror.state.user.name,
    getCurrentPersonaId: () => mirror.state.user.name,
    getPersonaAvatarPath: () => mirror.state.user.avatarUrl,

    // slash commands
    triggerSlash: (command: string) => transport.call<string>('triggerSlash', command),
    triggerSlashWithResult: (command: string) => transport.call<string>('triggerSlash', command),

    // generation
    generate: (generateConfig?: Record<string, unknown>) => generate('generate', generateConfig),
    generateRaw: (generateConfig?: Record<string, unknown>) => generate('generateRaw', generateConfig),
    stopAllGeneration: () => {
      transport.notify('stopGeneration', null);
      return true;
    },
    stopGenerationById: (id: string) => {
      transport.notify('stopGeneration', id);
      return true;
    },
    getModelList: async () => [],
    getProxyPresetNames: () => [],

    // prompt injections
    injectPrompts: (
      prompts: {
        id: string;
        position: 'in_chat' | 'none';
        depth: number;
        role: string;
        content: string;
        should_scan?: boolean;
      }[],
      options: { once?: boolean } = {},
    ) => {
      transport.notify('injectPrompts', prompts, options);
      return {
        uninject: () =>
          transport.notify(
            'uninjectPrompts',
            prompts.map((p) => p.id),
          ),
      };
    },
    uninjectPrompts: (ids: string[]) => transport.notify('uninjectPrompts', ids),

    // regex
    formatAsTavernRegexedString,
    isCharacterTavernRegexesEnabled: () => mirror.state.regex.characterEnabled,
    getTavernRegexes: (
      option: { scope?: 'all' | 'global' | 'character'; enable_state?: 'all' | 'enabled' | 'disabled' } = {},
    ) => {
      const regex = mirror.state.regex;
      const scope = option.scope ?? 'all';
      const list = [
        ...(scope === 'character' ? [] : regex.global.map((s) => toTavernRegex(s, 'global'))),
        ...(scope === 'global' ? [] : regex.character.map((s) => toTavernRegex(s, 'character'))),
      ];
      const state = option.enable_state ?? 'all';
      return list.filter((r) => state === 'all' || r.enabled === (state === 'enabled'));
    },

    // script buttons and info
    getButtonEvent: (name: string) => buttonEvent(scriptId(), name),
    getScriptButtons: () => structuredClone(buttons()),
    replaceScriptButtons: (list: ScriptButton[]) => replaceButtons(list),
    appendInexistentScriptButtons: (list: ScriptButton[]) => {
      const current = buttons();
      replaceButtons([...current, ...list.filter((b) => !current.some((c) => c.name === b.name))]);
    },
    updateScriptButtonsWith: (updater: (list: ScriptButton[]) => ScriptButton[]) => {
      const next = updater(structuredClone(buttons()));
      replaceButtons(next);
      return next;
    },
    getAllEnabledScriptButtons: () =>
      Object.fromEntries(
        Object.entries(mirror.state.scripts).map(([id, script]) => [
          id,
          script.buttons
            .filter((b) => b.visible)
            .map((b) => ({ button_id: buttonEvent(id, b.name), button_name: b.name })),
        ]),
      ),
    getScriptName: () => mirror.state.scripts[scriptId()]?.name ?? '',
    getScriptInfo: () => mirror.state.scripts[scriptId()]?.info ?? '',
    replaceScriptInfo: () => {},

    // versions
    getTavernHelperVersion: () => TAVERN_HELPER_VERSION,
    getFrontendVersion: () => TAVERN_HELPER_VERSION,
    getTavernVersion: () => TAVERN_VERSION,
    updateTavernHelper: async () => false,
    updateFrontendVersion: async () => false,

    // what a sandboxed frame cannot reach
    registerMacroLike: () => ({ unregister: () => {} }),
    unregisterMacroLike: () => {},
    playAudio: () => {},
    pauseAudio: () => {},
    getAudioList: () => [],
    replaceAudioList: () => {},
    appendAudioList: () => {},
    getAudioSettings: () => ({ enabled: false, mode: 'repeat_all', muted: false, volume: 50 }),
    setAudioSettings: () => {},
    getCurrentAudio: () => null,
    builtin: {},
    iframe_events: iframeEvents,
  };
}
