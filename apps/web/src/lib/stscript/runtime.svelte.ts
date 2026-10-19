/**
 * STscript in the app: one runtime with the core commands and the ones that act on the chat, the
 * UI and the settings. Scripts typed into the composer run here (SillyTavern
 * `executeSlashCommandsOnChatInput`).
 */

import {
  registerBuiltinCommands,
  ScriptAbortController,
  Stscript,
  type ClosureResult,
  type ExecuteOptions,
  type Scope,
} from '@bakatavern/core';

import { macros } from '../generation/pipeline.ts';
import { t } from '../i18n/index.svelte.ts';
import { chat } from '../state/chat.svelte.ts';
import { ui } from '../state/ui.svelte.ts';
import { globalVariables } from '../state/variables.ts';
import { scriptDialogs } from './dialogs.svelte.ts';

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Adds commands to the runtime (each area of the app registers its own). */
export type CommandModule = (st: Stscript) => void;

const modules: CommandModule[] = [];

/** Registers a module of commands; it is added when the runtime is created (or right away). */
export function addCommands(module: CommandModule) {
  modules.push(module);
  if (instance) module(instance);
}

let instance: Stscript | null = null;

class ScriptRunner {
  /** Scripts started from the composer that are still running. */
  running = $state(0);
  #controllers = new Set<ScriptAbortController>();

  get st(): Stscript {
    if (!instance) {
      instance = new Stscript({
        macros,
        env: () => chat.macroEnv(),
        variables: () => ({ local: chat.chatVariables(), global: globalVariables() }),
        chatName: () => chat.chat?.title ?? '',
        ui: {
          toast: (text, kind, options) =>
            ui.toast(text, kind, { title: options?.title, html: options?.html }),
          popup: async (content, options) => {
            await scriptDialogs.open({
              kind: 'popup',
              body: options?.html ? content : escapeHtml(content).replaceAll('\n', '<br>'),
              okButton: t('script.ok'),
              cancelButton: null,
              wide: true,
            });
          },
          systemMessage: (text, options) =>
            chat.addSystemMessage(options?.html ? text : escapeHtml(text), { uses_system_ui: true }),
        },
        runQuickReply: (name, args, options) => runQuickReplyByName(name, args, options),
      });
      registerBuiltinCommands(instance);
      for (const module of modules) module(instance);
    }
    return instance;
  }

  /**
   * Runs a script typed into the composer. Errors and aborts are reported; Stop aborts it.
   * Chat variables it changed are saved when it ends.
   */
  async runInput(text: string, scope: Scope | null = null): Promise<ClosureResult | null> {
    const controller = new ScriptAbortController();
    this.#controllers.add(controller);
    this.running++;
    try {
      return await this.st.execute(text, {
        scope,
        abortController: controller,
        handleParserErrors: true,
        handleExecutionErrors: true,
      });
    } finally {
      this.running--;
      this.#controllers.delete(controller);
      await chat.flushVariables();
    }
  }

  /** Runs a script with error handling, e.g. a Quick Reply or a plugin's. */
  async run(text: string, options: ExecuteOptions = {}): Promise<ClosureResult | null> {
    const controller = options.abortController ?? new ScriptAbortController();
    this.#controllers.add(controller);
    try {
      return await this.st.execute(text, {
        handleParserErrors: true,
        handleExecutionErrors: true,
        ...options,
        abortController: controller,
      });
    } finally {
      this.#controllers.delete(controller);
      await chat.flushVariables();
    }
  }

  /** Stops every running script (the Stop button). */
  abortAll() {
    for (const controller of this.#controllers) controller.abort(t('script.stopped'), true);
  }
}

export const scripts = new ScriptRunner();

/** Quick Replies plug in here (they load with their own module). */
let runQuickReplyByName: (
  name: string,
  args: Record<string, unknown>,
  options: ExecuteOptions,
) => Promise<unknown> = async () => {
  throw new Error(t('script.noQuickReplies'));
};

export function setQuickReplyRunner(runner: typeof runQuickReplyByName) {
  runQuickReplyByName = runner;
}
