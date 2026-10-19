/**
 * TavernHelper's variable functions (`function/variables.ts`): read from the frame's copy, written
 * there at once and saved by the page.
 */

import _ from 'lodash';

import type { FrameConfig } from '../../protocol.ts';
import type { Runtime } from '../context.ts';
import { swipeLists } from '../state.ts';

export type VariableOption =
  | { type: 'chat' | 'preset' | 'global' | 'character' }
  | { type: 'message'; message_id?: number | 'latest' }
  | { type: 'script'; script_id?: string }
  | { type: 'extension'; extension_id: string };

/** Where a page stores variables of a kind; messages by index, scripts by id. */
export type VariableTarget =
  | { type: 'chat' | 'preset' | 'global' | 'character' }
  | { type: 'message'; index: number }
  | { type: 'script'; script_id: string };

type Variables = Record<string, unknown>;

export function variablesApi(rt: Runtime, config: FrameConfig) {
  const { mirror } = rt;
  const isMessageFrame = config.kind === 'message';

  /** The option with the frame's own script filled in (TavernHelper's `_bind` versions). */
  const own = (option: VariableOption = { type: 'chat' }): VariableOption =>
    option.type === 'script' && !option.script_id ? { type: 'script', script_id: scriptId() } : option;

  const scriptId = () => {
    if (!config.scriptId) throw new Error('你只能在脚本 iframe 内获取 getScriptId!');
    return config.scriptId;
  };

  /** The variables an option names, without copying them, and where they are saved. */
  function locate(option: VariableOption): { variables: Variables; target: VariableTarget | null } {
    const state = mirror.state;
    switch (option.type) {
      case 'message': {
        const latest = option.message_id === undefined || option.message_id === 'latest';
        const id = latest ? -1 : (option.message_id as number);
        const length = state.messages.length;
        if (!(id >= -length && id < length)) {
          throw new Error(
            `提供的消息楼层号 '${String(option.message_id)}' 超出了范围 [${-length}, ${length})`,
          );
        }
        // `latest` is the last message the model sees.
        const index = latest ? state.messages.findLastIndex((m) => !m.is_hidden) : id < 0 ? length + id : id;
        const message = state.messages[index];
        if (!message) return { variables: {}, target: null };
        return {
          variables: message.swipes_data[message.swipe_id] ?? {},
          target: { type: 'message', index },
        };
      }
      case 'chat':
        return { variables: state.variables.chat, target: { type: 'chat' } };
      case 'global':
        return { variables: state.variables.global, target: { type: 'global' } };
      case 'preset':
        return { variables: state.variables.preset, target: { type: 'preset' } };
      case 'character':
        return { variables: state.variables.character ?? {}, target: { type: 'character' } };
      case 'script': {
        if (!option.script_id) throw new Error('获取变量失败, 未指定 script_id');
        return {
          variables: state.scripts[option.script_id]?.data ?? {},
          target: { type: 'script', script_id: option.script_id },
        };
      }
      case 'extension':
        return { variables: {}, target: null };
    }
  }

  function getVariables(option?: VariableOption): Variables {
    return structuredClone(locate(own(option)).variables);
  }

  function replaceVariables(variables: Variables, option?: VariableOption): void {
    const normalized = own(option);
    if (normalized.type === 'message') {
      const { target } = locate(normalized);
      if (!target || target.type !== 'message') return;
      const message = mirror.state.messages[target.index]!;
      const lists = swipeLists(message);
      lists.swipes_data[message.swipe_id] = variables;
      message.swipes_data = lists.swipes_data;
      rt.transport.notify('replaceVariables', variables, target);
      return;
    }
    const state = mirror.state;
    switch (normalized.type) {
      case 'chat':
        state.variables.chat = variables;
        break;
      case 'global':
        state.variables.global = variables;
        break;
      case 'preset':
        state.variables.preset = variables;
        break;
      case 'character':
        if (!state.character) throw new Error('当前没有打开角色卡，保存角色卡变量失败');
        state.variables.character = variables;
        break;
      case 'script': {
        if (!normalized.script_id) throw new Error('保存变量失败, 未指定 script_id');
        const script = state.scripts[normalized.script_id];
        if (!script) return;
        script.data = variables;
        rt.transport.notify('replaceVariables', variables, {
          type: 'script',
          script_id: normalized.script_id,
        });
        return;
      }
      case 'extension':
        return;
    }
    rt.transport.notify('replaceVariables', variables, { type: normalized.type });
  }

  function updateVariablesWith(
    updater: (variables: Variables) => Variables | Promise<Variables>,
    option?: VariableOption,
  ): Variables | Promise<Variables> {
    const normalized = own(option);
    const result = updater(getVariables(normalized));
    if (result instanceof Promise) {
      return result.then((value) => {
        replaceVariables(value, normalized);
        return value;
      });
    }
    replaceVariables(result, normalized);
    return result;
  }

  const keepArrays = (_lhs: unknown, rhs: unknown) => (Array.isArray(rhs) ? rhs : undefined);

  function insertOrAssignVariables(variables: Variables, option?: VariableOption): Variables {
    return updateVariablesWith((old) => _.mergeWith(old, variables, keepArrays), option) as Variables;
  }

  function insertVariables(variables: Variables, option?: VariableOption): Variables {
    return updateVariablesWith((old) => _.mergeWith({}, variables, old, keepArrays), option) as Variables;
  }

  function deleteVariable(path: string, option?: VariableOption) {
    let deleted = false;
    const variables = updateVariablesWith((old) => {
      deleted = _.unset(old, path);
      return old;
    }, option) as Variables;
    return { variables, delete_occurred: deleted };
  }

  /** Global, character, then (scripts) the script's or (messages) every message's up to this one. */
  function getAllVariables(): Variables {
    const state = mirror.state;
    const result: Variables = {};
    Object.assign(result, state.variables.global, state.variables.character ?? {});
    if (!isMessageFrame && config.scriptId) Object.assign(result, state.scripts[config.scriptId]?.data ?? {});
    Object.assign(result, state.variables.chat);
    if (isMessageFrame) {
      for (const message of state.messages.slice(0, (config.messageId ?? -1) + 1)) {
        Object.assign(result, message.swipes_data[message.swipe_id] ?? {});
      }
    }
    return structuredClone(result);
  }

  return {
    getVariables,
    replaceVariables,
    updateVariablesWith,
    insertOrAssignVariables,
    insertVariables,
    deleteVariable,
    getAllVariables,
    registerVariableSchema: () => {},
  };
}
