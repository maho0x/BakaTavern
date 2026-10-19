/**
 * Plugins (`@bakatavern/plugin-api`): ES modules kept as files on the server, listed in the
 * `plugins` settings, loaded into the page and given a context that opens only what their
 * permissions name. Turning one off undoes everything it registered.
 */

import { ExtensionPromptPosition, ExtensionPromptRole, type ExtensionPrompt } from '@bakatavern/core';
import type {
  ChatMessage,
  Dispose,
  Permission,
  Plugin,
  PluginContext,
  PluginManifest,
} from '@bakatavern/plugin-api';

import { api } from '../api.ts';
import { events, eventTypes } from '../events.ts';
import { generateQuiet, generateRaw } from '../generation/background.svelte.ts';
import { addGenerationHooks, type HookMessage } from '../generation/hooks.ts';
import { addInjectionSource } from '../generation/injections.ts';
import { macros } from '../generation/pipeline.ts';
import { registerTool, unregisterTool } from '../generation/tools.ts';
import { t } from '../i18n/index.svelte.ts';
import { chat } from '../state/chat.svelte.ts';
import { settings } from '../state/settings.svelte.ts';
import { errorText, ui } from '../state/ui.svelte.ts';
import { scripts } from '../stscript/runtime.svelte.ts';
import { pluginExtensions } from './extensions.svelte.ts';

export const PERMISSIONS: Permission[] = ['chat', 'generate', 'prompt', 'commands', 'tools', 'network', 'ui'];

export interface InstalledPlugin extends PluginManifest {
  /** The module's file on the server (content hash). */
  file: string;
  /** Where it came from: a file name or a URL. */
  source: string;
  enabled: boolean;
}

interface PluginsPrefs {
  installed: InstalledPlugin[];
}

const NAMESPACE = 'plugins';
const defaults: PluginsPrefs = { installed: [] };

/** Loads a plugin module from its code. */
async function importPlugin(code: string): Promise<Plugin> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    const module = (await import(/* @vite-ignore */ url)) as { default?: Plugin };
    const plugin = module.default;
    if (!plugin || typeof plugin !== 'object' || typeof plugin.activate !== 'function') {
      throw new Error(t('plugins.notPlugin'));
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(plugin.id ?? ''))) throw new Error(t('plugins.badId'));
    const unknown = (plugin.permissions ?? []).filter((p) => !PERMISSIONS.includes(p));
    if (unknown.length) throw new Error(t('plugins.unknownPermission', { names: unknown.join(', ') }));
    return plugin;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function manifestOf(plugin: Plugin): PluginManifest {
  return {
    id: plugin.id,
    name: String(plugin.name || plugin.id),
    version: String(plugin.version ?? ''),
    description: plugin.description ? String(plugin.description) : undefined,
    author: plugin.author ? String(plugin.author) : undefined,
    apiVersion: plugin.apiVersion,
    permissions: [...(plugin.permissions ?? [])],
  };
}

const roles: Record<string, number> = {
  system: ExtensionPromptRole.SYSTEM,
  user: ExtensionPromptRole.USER,
  assistant: ExtensionPromptRole.ASSISTANT,
};
const positions: Record<string, number> = {
  in_prompt: ExtensionPromptPosition.IN_PROMPT,
  in_chat: ExtensionPromptPosition.IN_CHAT,
  before_prompt: ExtensionPromptPosition.BEFORE_PROMPT,
  none: ExtensionPromptPosition.NONE,
};

class PluginHost {
  /** Plugins that failed to load or start, with why. */
  errors = $state<Record<string, string>>({});
  /** Plugins running now. */
  running = $state<string[]>([]);
  readonly #disposers = new Map<string, Dispose[]>();

  get installed(): InstalledPlugin[] {
    return settings.get<PluginsPrefs>(NAMESPACE, defaults).installed ?? [];
  }

  /** Saved at once: which plugins run must not wait for a debounce (or be lost with the page). */
  #save(installed: InstalledPlugin[]) {
    settings.update(NAMESPACE, { installed });
    void settings.flush(NAMESPACE);
  }

  /** Starts every enabled plugin (once, when the app starts). */
  async startAll() {
    for (const entry of this.installed) if (entry.enabled) await this.#start(entry);
  }

  /**
   * Installs a plugin from its code after the user granted its permissions; an installed plugin of
   * the same id is replaced. Returns false when the user declined.
   */
  async install(code: string, source: string): Promise<boolean> {
    const plugin = await importPlugin(code);
    const manifest = manifestOf(plugin);
    const list = manifest.permissions
      .map((p) => `• ${t(`plugins.perm.${p}` as 'plugins.perm.chat')}`)
      .join('\n');
    const question = t('plugins.confirmInstall', {
      name: `${manifest.name} ${manifest.version}`.trim(),
      permissions: list || t('plugins.noPermissions'),
    });
    if (!confirm(question)) return false;
    const file = await api.uploadFile(new File([code], `${manifest.id}.js`, { type: 'text/javascript' }));
    this.#stop(manifest.id);
    const entry: InstalledPlugin = { ...manifest, file: file.hash, source, enabled: true };
    this.#save([...this.installed.filter((p) => p.id !== manifest.id), entry]);
    await this.#start(entry, plugin);
    return true;
  }

  async setEnabled(id: string, enabled: boolean) {
    const entry = this.installed.find((p) => p.id === id);
    if (!entry) return;
    this.#save(this.installed.map((p) => (p.id === id ? { ...p, enabled } : p)));
    if (enabled) await this.#start({ ...entry, enabled });
    else this.#stop(id);
  }

  uninstall(id: string) {
    this.#stop(id);
    this.#save(this.installed.filter((p) => p.id !== id));
    settings.replace(`plugin.${id}`, {});
  }

  async #start(entry: InstalledPlugin, loaded?: Plugin) {
    if (this.#disposers.has(entry.id)) return;
    const disposers: Dispose[] = [];
    this.#disposers.set(entry.id, disposers);
    // Stopped (or replaced) while it was loading: what it registered goes at once.
    const current = () => this.#disposers.get(entry.id) === disposers;
    try {
      const plugin = loaded ?? (await importPlugin(await (await fetch(api.fileUrl(entry.file))).text()));
      if (!current()) return;
      const cleanup = await plugin.activate(this.#context(entry, disposers));
      if (typeof cleanup === 'function') disposers.push(cleanup);
      if (!current()) {
        this.#dispose(entry.id, disposers);
        return;
      }
      this.running = [...this.running.filter((id) => id !== entry.id), entry.id];
      delete this.errors[entry.id];
    } catch (error) {
      if (!current()) return;
      this.errors[entry.id] = errorText(error);
      this.#stop(entry.id);
      ui.toast(t('plugins.startFailed', { name: entry.name, message: errorText(error) }), 'error');
    }
  }

  #stop(id: string) {
    const disposers = this.#disposers.get(id);
    this.#disposers.delete(id);
    if (disposers) this.#dispose(id, disposers);
    this.running = this.running.filter((r) => r !== id);
  }

  #dispose(id: string, disposers: Dispose[]) {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error(`[plugins] ${id} did not stop cleanly`, error);
      }
    }
  }

  /** What a plugin may reach: everything it registers is undone when it stops. */
  #context(entry: InstalledPlugin, disposers: Dispose[]): PluginContext {
    const id = entry.id;
    const need = (permission: Permission) => {
      if (!entry.permissions.includes(permission)) {
        throw new Error(t('plugins.missingPermission', { name: entry.name, permission }));
      }
    };
    const track = (dispose: Dispose): Dispose => {
      disposers.push(dispose);
      return () => {
        dispose();
        const i = disposers.indexOf(dispose);
        if (i >= 0) disposers.splice(i, 1);
      };
    };
    const namespace = `plugin.${id}`;
    const stored = () => settings.get<Record<string, unknown>>(namespace, {});
    const toChatMessage = (message: HookMessage): ChatMessage => ({ ...message });

    const injections: Record<string, ExtensionPrompt> = {};
    track(
      addInjectionSource(() =>
        Object.fromEntries(
          Object.entries(injections).map(([key, prompt]) => [`plugin_${id}_${key}`, prompt]),
        ),
      ),
    );

    return {
      manifest: Object.freeze({ ...entry }),
      events: {
        on: (event, listener) => track(events.on(event, listener)),
        once: (event, listener) => track(events.once(event, listener)),
        emit: (event, ...args) => events.emit(event, ...args),
        types: eventTypes,
      },
      storage: {
        get: <T>(key: string) => stored()[key] as T | undefined,
        set: (key, value) => settings.replace(namespace, { ...stored(), [key]: value }),
        delete: (key) => {
          const next = { ...stored() };
          delete next[key];
          settings.replace(namespace, next);
        },
      },
      chat: {
        messages: () => {
          need('chat');
          return chat.messages.map((m, index) =>
            toChatMessage({
              index,
              name: m.name,
              role: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant',
              hidden: m.hidden,
              text: m.swipes[m.swipeId]?.content ?? '',
              extra: $state.snapshot(m.extra) as Record<string, unknown>,
            }),
          );
        },
        current: () =>
          chat.chat
            ? { id: chat.chat.id, title: chat.chat.title, characterName: chat.character?.name ?? null }
            : null,
        getData: <T>(key: string) => {
          need('chat');
          const all =
            (chat.chat?.metadata.plugins as Record<string, Record<string, unknown>> | undefined) ?? {};
          return all[id]?.[key] as T | undefined;
        },
        setData: async (key, value) => {
          need('chat');
          const all = { ...((chat.chat?.metadata.plugins as Record<string, Record<string, unknown>>) ?? {}) };
          all[id] = { ...all[id], [key]: value };
          await chat.updateMetadata({ plugins: all });
        },
        addMessage: async (message) => {
          need('chat');
          await chat.insertMessages([
            {
              role: message.role,
              name:
                message.name ??
                (message.role === 'user' ? chat.userName : (chat.character?.name ?? 'System')),
              swipes: [{ content: message.text, info: {} }],
              sendDate: new Date().toISOString(),
              extra: message.role === 'system' ? { type: 'narrator' } : {},
            },
          ]);
        },
      },
      llm: {
        generate: (prompt, options) => {
          need('generate');
          return generateQuiet({ prompt, responseLength: options?.responseLength });
        },
        generateRaw: (messages, options) => {
          need('generate');
          return generateRaw({
            prompt: messages,
            systemPrompt: options?.systemPrompt,
            responseLength: options?.responseLength,
          });
        },
      },
      prompt: {
        inject: (key, injection) => {
          need('prompt');
          injections[key] = {
            value: injection.content,
            position: positions[injection.position] ?? ExtensionPromptPosition.IN_PROMPT,
            depth: injection.depth ?? 4,
            role: roles[injection.role ?? 'system'] ?? ExtensionPromptRole.SYSTEM,
            scan: Boolean(injection.scan),
          };
        },
        uninject: (key) => void delete injections[key],
        hooks: (hooks) => {
          need('prompt');
          return track(addGenerationHooks(hooks));
        },
      },
      commands: {
        register: (command) => {
          need('commands');
          const st = scripts.st;
          st.commands.add({
            name: command.name,
            aliases: command.aliases,
            helpString: command.helpString,
            callback: (args, value) => command.callback(args, value) as never,
          });
          return track(() => st.commands.remove(command.name));
        },
        run: async (script) => {
          need('commands');
          const result = await scripts.run(script);
          return String(result?.pipe ?? '');
        },
      },
      macros: {
        register: (name, handler, description) => {
          need('commands');
          macros.registry.register(name, {
            handler: (call) => handler(call.args) as string,
            description,
            category: `plugin:${id}`,
          });
          return track(() => macros.registry.unregister(name));
        },
      },
      tools: {
        register: (tool) => {
          need('tools');
          registerTool(tool);
          return track(() => unregisterTool(tool.name));
        },
      },
      net: {
        fetch: async (url, init) => {
          need('network');
          const response = await api.proxy({
            url,
            method: (init?.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE',
            headers: init?.headers,
            body: init?.body,
          });
          const text = await response.text();
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          };
        },
      },
      ui: {
        toast: (message, kind = 'info') => ui.toast(String(message), kind, { title: entry.name }),
        settings: (mount) => {
          need('ui');
          return track(pluginExtensions.addSettings(id, mount));
        },
        messageAction: (action) => {
          need('ui');
          return track(pluginExtensions.addMessageAction(id, action));
        },
        composerAction: (action) => {
          need('ui');
          return track(pluginExtensions.addComposerAction(id, action));
        },
      },
    };
  }
}

export const plugins = new PluginHost();
