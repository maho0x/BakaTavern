/** Runs an STscript case through BakaTavern's runtime, as SillyTavern ran it. */

import { createMacroEngine, objectVariables, registerBuiltinCommands, Stscript } from '@bakatavern/core';

import type { Scenario } from './scenarios.ts';
import { CHAT_NAME } from './st-data.ts';
import type { StscriptCase } from './stscript-cases.ts';

/** What a script left behind: its result (or error) and the variables. */
export interface StscriptOutcome {
  pipe?: string | null;
  isAborted?: boolean;
  isQuietlyAborted?: boolean;
  abortReason?: string | null;
  isBreak?: boolean;
  error?: string;
  local: Record<string, unknown>;
  global: Record<string, unknown>;
}

/** The chat the scripts run in: a character and its greeting. */
export function stscriptScenario(): Scenario {
  return {
    id: 'stscript',
    title: 'STscript cases',
    card: { name: 'Aiko', first_mes: 'Hello.' },
    history: [],
    type: 'normal',
  };
}

export async function bakaTavernStscript(c: StscriptCase): Promise<StscriptOutcome> {
  const local: Record<string, unknown> = { ...c.local };
  const global: Record<string, unknown> = { ...c.global };
  const stores = { local: objectVariables(local), global: objectVariables(global) };
  const st = new Stscript({
    macros: createMacroEngine(),
    env: () => ({ user: 'User', char: 'Aiko', localVariables: stores.local, globalVariables: stores.global }),
    variables: () => stores,
    chatName: () => CHAT_NAME,
    ui: { toast: () => {}, popup: async () => {}, systemMessage: async () => {} },
  });
  registerBuiltinCommands(st);
  let outcome: Omit<StscriptOutcome, 'local' | 'global'>;
  try {
    const r = await st.execute(c.script, { handleParserErrors: false, handleExecutionErrors: false });
    outcome = {
      pipe: r?.pipe === undefined ? null : String(r.pipe),
      isAborted: r?.isAborted,
      isQuietlyAborted: r?.isQuietlyAborted,
      abortReason: r?.abortReason || null,
      isBreak: r?.isBreak,
    };
  } catch (error) {
    outcome = { error: (error as Error).message };
  }
  return JSON.parse(JSON.stringify({ ...outcome, local, global })) as StscriptOutcome;
}
