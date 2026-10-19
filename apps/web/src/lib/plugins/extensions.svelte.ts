/** Where plugins add to the interface: message and composer menu entries, settings sections. */

export interface PluginAction<A extends unknown[] = []> {
  key: string;
  plugin: string;
  label: string;
  onClick(...args: A): unknown;
}

export interface PluginSettingsSection {
  key: string;
  plugin: string;
  mount(element: HTMLElement): void | (() => void);
}

let next = 0;

class PluginExtensions {
  messageActions = $state.raw<PluginAction<[number]>[]>([]);
  composerActions = $state.raw<PluginAction[]>([]);
  settings = $state.raw<PluginSettingsSection[]>([]);

  addMessageAction(plugin: string, action: { label: string; onClick(index: number): unknown }) {
    const entry = { ...action, plugin, key: `${plugin}:${next++}` };
    this.messageActions = [...this.messageActions, entry];
    return () => (this.messageActions = this.messageActions.filter((a) => a !== entry));
  }

  addComposerAction(plugin: string, action: { label: string; onClick(): unknown }) {
    const entry = { ...action, plugin, key: `${plugin}:${next++}` };
    this.composerActions = [...this.composerActions, entry];
    return () => (this.composerActions = this.composerActions.filter((a) => a !== entry));
  }

  addSettings(plugin: string, mount: PluginSettingsSection['mount']) {
    const entry = { plugin, mount, key: `${plugin}:${next++}` };
    this.settings = [...this.settings, entry];
    return () => (this.settings = this.settings.filter((s) => s !== entry));
  }
}

export const pluginExtensions = new PluginExtensions();
