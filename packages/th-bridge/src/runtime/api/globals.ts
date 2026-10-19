/**
 * Globals frames share (`initializeGlobal`, `waitGlobalInitialized`), such as MVU's `Mvu`. Frames
 * cannot share objects across the sandbox, so other frames get a copy of the data and functions
 * that run in the frame that owns the global (and answer asynchronously). MVU's data is message
 * variables, so its synchronous reads are answered from the frame's own copy.
 */

import type { GlobalShape, HostMessage } from '../../protocol.ts';
import type { Runtime } from '../context.ts';
import { plain } from '../transport.ts';
import type { variablesApi, VariableOption } from './variables.ts';

type Variables = ReturnType<typeof variablesApi>;

export function globalsApi(rt: Runtime, variables: Variables, initial: Record<string, GlobalShape>) {
  const { transport } = rt;
  const own = new Map<string, unknown>();
  const known = new Set<string>();
  const waiting = new Map<string, ((value: unknown) => void)[]>();
  const target = window as unknown as Record<string, unknown>;

  const settle = (name: string) => {
    for (const resolve of waiting.get(name) ?? []) resolve(target[name]);
    waiting.delete(name);
  };

  /** Another frame's global, as functions that call into that frame. */
  function proxy(name: string, shape: GlobalShape): unknown {
    const value: Record<string, unknown> =
      shape.data && typeof shape.data === 'object'
        ? structuredClone(shape.data as Record<string, unknown>)
        : {};
    for (const fn of shape.functions) {
      value[fn] = (...args: unknown[]) =>
        transport.request((id) => ({ type: 'global-call', id, name, fn, args: plain(args) as unknown[] }));
    }
    if (name === 'Mvu') {
      value.getMvuData = (options: VariableOption) => variables.getVariables(options);
      value.replaceMvuData = async (data: Record<string, unknown>, options: VariableOption) =>
        variables.replaceVariables(data, options);
      value.isDuringExtraAnalysis = () => false;
    }
    return value;
  }

  function define(name: string, shape: GlobalShape) {
    if (own.has(name)) return;
    target[name] = proxy(name, shape);
    known.add(name);
    settle(name);
  }

  for (const [name, shape] of Object.entries(initial)) define(name, shape);

  transport.onMessage(async (message: HostMessage) => {
    if (message.type === 'global') define(message.name, message.shape);
    if (message.type === 'global-call') {
      const owner = own.get(message.name) as Record<string, (...args: unknown[]) => unknown> | undefined;
      try {
        const fn = owner?.[message.fn];
        if (typeof fn !== 'function') throw new Error(`${message.name}.${message.fn} is not a function`);
        const value = await fn.apply(owner, message.args);
        transport.send({ type: 'global-result', id: message.id, value: plain(value) });
      } catch (error) {
        transport.send({ type: 'global-result', id: message.id, error: String(error) });
      }
    }
  });

  return {
    initializeGlobal(name: string, value: unknown) {
      own.set(name, value);
      known.add(name);
      target[name] = value;
      const functions =
        value && typeof value === 'object'
          ? Object.keys(value).filter((key) => typeof (value as Record<string, unknown>)[key] === 'function')
          : [];
      transport.send({ type: 'global', name, shape: { data: plain(value), functions } });
      settle(name);
    },
    waitGlobalInitialized<T>(name: string): Promise<T> {
      if (known.has(name)) return Promise.resolve(target[name] as T);
      return new Promise<T>((resolve) => {
        const list = waiting.get(name) ?? [];
        list.push(resolve as (value: unknown) => void);
        waiting.set(name, list);
      });
    },
  };
}
