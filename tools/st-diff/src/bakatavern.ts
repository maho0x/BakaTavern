/** Builds BakaTavern's request for a scenario, from the same inputs SillyTavern was given. */

import {
  createMacroEngine,
  estimateTokenizer,
  getProvider,
  normalizeChatCompletionPreset,
  prepareGeneration,
  type LoadedBook,
  type StoredMessage,
  type WorldInfoSettings,
} from '@bakatavern/core';

import { defaultModels, stWorldInfoDefaults, type Scenario, type StWorldInfoSettings } from './scenarios.ts';
import { scenarioChat, scenarioPersona, scenarioPreset, stCard } from './st-data.ts';

function worldInfoSettings(s: StWorldInfoSettings): WorldInfoSettings {
  return {
    depth: s.world_info_depth,
    minActivations: s.world_info_min_activations,
    minActivationsDepthMax: s.world_info_min_activations_depth_max,
    budget: s.world_info_budget,
    budgetCap: s.world_info_budget_cap,
    includeNames: s.world_info_include_names,
    recursive: s.world_info_recursive,
    maxRecursionSteps: s.world_info_max_recursion_steps,
    caseSensitive: s.world_info_case_sensitive,
    matchWholeWords: s.world_info_match_whole_words,
    useGroupScoring: s.world_info_use_group_scoring,
    characterStrategy: s.world_info_character_strategy,
    overflowAlert: s.world_info_overflow_alert,
  };
}

export async function bakaTavernRequest(scenario: Scenario, defaultPreset: Record<string, unknown>) {
  const provider = scenario.provider ?? 'custom';
  const persona = scenarioPersona(scenario);
  const messages: StoredMessage[] = scenarioChat(scenario).map((m) => ({
    name: m.name ?? (m.user ? persona.name : scenario.card.name),
    role: m.user ? 'user' : 'assistant',
    hidden: !!m.hidden,
    content: m.mes,
    swipeId: 0,
    swipeCount: 1,
    extra: {},
  }));
  if (scenario.type === 'normal' && scenario.input) {
    // The input box text becomes a user message before the prompt is built.
    messages.push({
      name: persona.name,
      role: 'user',
      hidden: false,
      content: scenario.input,
      swipeId: 0,
      swipeCount: 1,
      extra: {},
    });
  }
  const wi = scenario.worldInfo;
  const books = (names: readonly string[]): LoadedBook[] =>
    names.map((name) => ({ name, entries: wi?.books[name] ?? [] }));
  const prepared = await prepareGeneration({
    type: scenario.type,
    card: stCard(scenario),
    characterKey: scenario.card.name,
    characterTags: [],
    persona,
    chatId: 'st-diff',
    chatMetadata: structuredClone(scenario.chatMetadata ?? {}),
    messages,
    preset: normalizeChatCompletionPreset(scenarioPreset(defaultPreset, scenario)),
    connection: {
      provider: getProvider(provider)!,
      model: defaultModels[provider],
      baseUrl: provider === 'makersuite' ? 'http://127.0.0.1:5057' : 'http://127.0.0.1:5057/v1',
    },
    worldInfo: {
      settings: worldInfoSettings({ ...stWorldInfoDefaults, ...wi?.settings }),
      global: books(wi?.global ?? []),
      character: books(wi?.character ? [wi.character] : []),
      chat: null,
      persona: null,
    },
    authorsNote: { allowWIScan: false },
    globalVariables: {},
    tokenizer: estimateTokenizer,
    macros: createMacroEngine(),
  });
  return {
    path: new URL(prepared.http.url).pathname,
    body: JSON.parse(prepared.http.body!) as Record<string, unknown>,
  };
}
