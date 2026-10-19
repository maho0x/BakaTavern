/**
 * Prompt injections from scripts and plugins (SillyTavern `setExtensionPrompt`): each source is
 * asked before a generation, its entries keyed like SillyTavern's extension prompts.
 */

import type { ExtensionPrompt, GenerationType } from '@bakatavern/core';

export interface InjectionContext {
  /** The chat's metadata (a copy; changes are ignored). */
  metadata: Record<string, unknown>;
  type: GenerationType;
}

export type InjectionSource = (
  context: InjectionContext,
) => Record<string, ExtensionPrompt> | Promise<Record<string, ExtensionPrompt>>;

const sources = new Set<InjectionSource>();

export function addInjectionSource(source: InjectionSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

export async function collectInjections(context: InjectionContext): Promise<Record<string, ExtensionPrompt>> {
  const all: Record<string, ExtensionPrompt> = {};
  for (const source of sources) {
    try {
      Object.assign(all, await source(context));
    } catch (error) {
      console.error('[injections] a source failed', error);
    }
  }
  return all;
}
