import type {
  CharacterSummary,
  Group,
  LorebookInfo,
  Persona,
  PresetInfo,
  SecretInfo,
  Tag,
} from '@bakatavern/api-client';

import { api } from '../api.ts';

/** Everything listed in the sidebars: characters, groups, personas, lorebooks, presets, keys, tags. */
class Library {
  characters = $state<CharacterSummary[]>([]);
  groups = $state<Group[]>([]);
  personas = $state<Persona[]>([]);
  lorebooks = $state<LorebookInfo[]>([]);
  presets = $state<PresetInfo[]>([]);
  secrets = $state<SecretInfo[]>([]);
  tags = $state<Tag[]>([]);

  character(id: string | null | undefined) {
    return id ? this.characters.find((c) => c.id === id) : undefined;
  }

  group(id: string | null | undefined) {
    return id ? this.groups.find((g) => g.id === id) : undefined;
  }

  upsertGroup(group: Group) {
    const index = this.groups.findIndex((g) => g.id === group.id);
    if (index >= 0) this.groups[index] = group;
    else this.groups.push(group);
    this.groups.sort((a, b) => a.name.localeCompare(b.name));
  }

  async refreshGroups() {
    this.groups = await api.listGroups();
  }

  persona(id: string | null | undefined) {
    return id ? this.personas.find((p) => p.id === id) : undefined;
  }

  upsertCharacter(summary: CharacterSummary) {
    const index = this.characters.findIndex((c) => c.id === summary.id);
    if (index >= 0) this.characters[index] = summary;
    else this.characters.push(summary);
    this.characters.sort((a, b) => a.name.localeCompare(b.name));
  }

  removeCharacter(id: string) {
    this.characters = this.characters.filter((c) => c.id !== id);
  }

  async refreshCharacters() {
    this.characters = await api.listCharacters();
  }

  async refreshPersonas() {
    this.personas = await api.listPersonas();
  }

  async refreshLorebooks() {
    this.lorebooks = await api.listLorebooks();
  }

  async refreshPresets() {
    this.presets = await api.listPresets();
  }

  async refreshSecrets() {
    this.secrets = await api.listSecrets();
  }

  async refreshTags() {
    this.tags = await api.listTags();
  }
}

export const library = new Library();
