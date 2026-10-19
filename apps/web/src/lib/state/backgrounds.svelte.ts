/**
 * Chat backgrounds: pictures kept as files, one shown everywhere and, per chat, one locked to it
 * (`chat_metadata.custom_background`, a CSS `url("backgrounds/<name>")` as SillyTavern writes it).
 */

import { api } from '../api.ts';
import { backgroundCss, backgroundName } from './background-names.ts';
import { chat } from './chat.svelte.ts';
import { backgroundDefaults, type BackgroundPrefs } from './prefs.ts';
import { settings } from './settings.svelte.ts';

export { backgroundCss, backgroundName };

class Backgrounds {
  get prefs(): BackgroundPrefs {
    return { ...backgroundDefaults, ...settings.get('backgrounds', backgroundDefaults) };
  }

  /** The background of the open chat: its own, else the one for every chat. */
  get active(): { name: string; url: string; locked: boolean } | null {
    const prefs = this.prefs;
    const locked = backgroundName(chat.chat?.metadata.custom_background);
    const name = locked ?? prefs.current;
    const item = name ? prefs.items.find((b) => b.name === name) : undefined;
    return item ? { name: item.name, url: api.fileUrl(item.hash), locked: Boolean(locked) } : null;
  }

  url(name: string): string | null {
    const item = this.prefs.items.find((b) => b.name === name);
    return item ? api.fileUrl(item.hash) : null;
  }

  setCurrent(name: string | null) {
    settings.update('backgrounds', { current: name });
  }

  setFit(fit: BackgroundPrefs['fit']) {
    settings.update('backgrounds', { fit });
  }

  /** Locks a background to the open chat (null unlocks it). */
  async setChat(name: string | null) {
    await chat.updateMetadata({ custom_background: name ? backgroundCss(name) : undefined });
  }

  /** Adds pictures under their file names (a taken name gets a number). */
  async upload(files: Iterable<File>) {
    const items = [...this.prefs.items];
    for (const file of files) {
      const stored = await api.uploadFile(file);
      const dot = file.name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [file.name.slice(0, dot), file.name.slice(dot)] : [file.name, ''];
      let name = file.name;
      for (let n = 2; items.some((b) => b.name === name); n++) name = `${stem} (${n})${ext}`;
      items.push({ name, hash: stored.hash });
    }
    settings.update('backgrounds', { items });
  }

  remove(name: string) {
    const prefs = this.prefs;
    settings.update('backgrounds', {
      items: prefs.items.filter((b) => b.name !== name),
      current: prefs.current === name ? null : prefs.current,
    });
  }
}

export const backgrounds = new Backgrounds();
