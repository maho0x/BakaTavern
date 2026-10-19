import type { VariableScope } from '@bakatavern/core';

import { settings } from './settings.svelte.ts';

/**
 * Global variables (SillyTavern `extension_settings.variables.global`), kept in the `variables`
 * settings and saved shortly after a change.
 */
export function globalVariables(): VariableScope {
  const read = () => settings.get('variables', {}) as Record<string, unknown>;
  return {
    get: (name) => read()[name],
    set: (name, value) => settings.replace('variables', { ...read(), [name]: value }),
    has: (name) => Object.hasOwn(read(), name),
    delete: (name) => {
      const next = { ...read() };
      delete next[name];
      settings.replace('variables', next);
    },
    entries: () => Object.entries(read()),
  };
}
