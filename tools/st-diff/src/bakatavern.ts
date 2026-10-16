/** Builds BakaTavern's request for a scenario, from the same inputs SillyTavern was given. */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  activeRegexScripts,
  chatTokenizer,
  createMacroEngine,
  createTokenizer,
  defaultFormattingSettings,
  getProvider,
  getRegexedString,
  loadStTemplates,
  normalizeChatCompletionPreset,
  normalizeContextTemplate,
  normalizeInstructTemplate,
  normalizeSystemPrompt,
  normalizeTextgenSettings,
  prepareGeneration,
  RegexPlacement,
  stTokenizerIds,
  textCountTokenizer,
  textIdTokenizer,
  type FormattingSettings,
  type LoadedBook,
  type MediaResolver,
  type RegexScript,
  type StoredMessage,
  type TextCompletionSetup,
  type Tokenizer,
  type TokenizerId,
  type WorldInfoSettings,
} from '@bakatavern/core';

import { mockModelEntry, mockTokenIds } from '../../mock-llm/src/server.ts';
import {
  scenarioModel,
  stReasoningDefaults,
  stWorldInfoDefaults,
  type Scenario,
  type StWorldInfoSettings,
} from './scenarios.ts';
import { scenarioChat, scenarioPersona, scenarioPreset, scenarioTextSettings, stCard } from './st-data.ts';

const MOCK_ORIGIN = 'http://127.0.0.1:5057';

/** The mock backend's tokenizer, which SillyTavern asks when the backend can tokenize. */
const mockRemoteTokenizer: Tokenizer = {
  id: 'remote',
  count: (text) => mockTokenIds(text).length,
  encode: mockTokenIds,
};

/**
 * A tokenizer as SillyTavern picks it. tiktoken encodings need no files; the others read them from
 * `BT_TOKENIZERS_DIR` and otherwise fall back to the estimate, so scenarios whose result depends
 * on token counts use tiktoken (Chat Completion) or `power.tokenizer` 0/1 (Text Completion).
 */
function tokenizer(id: TokenizerId | 'remote'): Promise<Tokenizer> {
  if (id === 'remote') return Promise.resolve(mockRemoteTokenizer);
  const dir = process.env.BT_TOKENIZERS_DIR;
  return createTokenizer(id, async (file) => {
    if (!dir) throw new Error('no tokenizer files');
    return readFile(join(dir, file));
  });
}

/** The tokenizers for counting and, in Text Completion, for token ids. */
async function scenarioTokenizers(scenario: Scenario): Promise<{ count: Tokenizer; ids?: Tokenizer }> {
  if (!scenario.text)
    return { count: await tokenizer(chatTokenizer(scenario.provider ?? 'custom', scenarioModel(scenario))) };
  const { type, model = '', power } = scenario.text;
  const setting = stTokenizerIds[Number(power?.tokenizer ?? 0)] ?? 'estimate';
  return {
    count: await tokenizer(textCountTokenizer(type, model, setting)),
    ids: await tokenizer(textIdTokenizer(type, model, setting)),
  };
}

/** The Text Completion side of a scenario, from the same settings SillyTavern was given. */
async function textSetup(
  scenario: Scenario,
  idTokenizer: Tokenizer | undefined,
): Promise<{ formatting: FormattingSettings; text: TextCompletionSetup }> {
  const tc = scenarioTextSettings(scenario, await loadStTemplates(), MOCK_ORIGIN);
  const power = tc.power as Record<string, unknown>;
  return {
    formatting: {
      ...defaultFormattingSettings,
      instructEnabled: Boolean(tc.instruct),
      instruct: normalizeInstructTemplate(tc.instruct),
      context: normalizeContextTemplate(tc.context),
      syspromptEnabled: tc.sysprompt.enabled,
      sysprompt: normalizeSystemPrompt(tc.sysprompt),
      preferCharacterPrompt: (power.prefer_character_prompt as boolean | undefined) ?? true,
      preferCharacterJailbreak: (power.prefer_character_jailbreak as boolean | undefined) ?? true,
      collapseNewlines: Boolean(power.collapse_newlines),
      tokenPadding: Number(power.token_padding ?? 64),
      stripExamples: Boolean(power.strip_examples),
    },
    text: {
      settings: normalizeTextgenSettings(tc.settings),
      maxContext: tc.maxContext,
      maxResponse: tc.maxResponse,
      idTokenizer,
    },
  };
}

/** PNG size from its header (SillyTavern reads it from the decoded image). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const MIME: Record<string, string> = { png: 'image/png', mp4: 'video/mp4', txt: 'text/plain' };

/** The scenario's files, as SillyTavern's browser fetches them from its user folder. */
function scenarioAttachments(scenario: Scenario): MediaResolver {
  const file = (url: string) => {
    const base64 = scenario.files?.[url];
    if (base64 === undefined) throw new Error(`no file ${url}`);
    return { base64, bytes: Buffer.from(base64, 'base64'), mime: MIME[url.split('.').pop()!] ?? '' };
  };
  return {
    image: async (url) => {
      const { base64, bytes, mime } = file(url);
      return { dataUrl: `data:${mime};base64,${base64}`, ...pngSize(bytes) };
    },
    // The clip is not a real video: SillyTavern cannot read its length either.
    video: async (url) => ({ dataUrl: `data:${file(url).mime};base64,${file(url).base64}` }),
    audio: async (url) => ({ dataUrl: `data:${file(url).mime};base64,${file(url).base64}` }),
    fileText: async (url) => file(url).bytes.toString('utf8'),
  };
}

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
  const macros = createMacroEngine();
  const card = stCard(scenario);
  const stPreset = scenarioPreset(defaultPreset, scenario);
  const preset = normalizeChatCompletionPreset(stPreset);
  const tokenizers = await scenarioTokenizers(scenario);
  const regexScripts = activeRegexScripts({
    global: scenario.regex?.global ?? [],
    preset: (preset.extensions as { regex_scripts?: RegexScript[] } | undefined)?.regex_scripts,
    presetAllowed: scenario.regex?.presetAllowed,
    character: (card.data.extensions as { regex_scripts?: RegexScript[] }).regex_scripts,
    characterAllowed: scenario.regex?.characterAllowed,
  });
  const messages: StoredMessage[] = scenarioChat(scenario).map((m) => ({
    name: m.name ?? (m.user ? persona.name : scenario.card.name),
    role: m.user ? 'user' : 'assistant',
    hidden: !!m.hidden,
    content: m.mes,
    swipeId: 0,
    swipeCount: 1,
    extra: { ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...m.extra },
  }));
  if (scenario.type === 'normal' && scenario.input) {
    // The input box text becomes a user message (through the user input regex) before the prompt
    // is built.
    const content = getRegexedString(scenario.input, RegexPlacement.USER_INPUT, regexScripts, (text, o) =>
      macros.evaluate(text, {
        user: persona.name,
        char: o?.charName ?? scenario.card.name,
        postProcess: o?.postProcess,
      }),
    );
    messages.push({
      name: persona.name,
      role: 'user',
      hidden: false,
      content,
      swipeId: 0,
      swipeCount: 1,
      extra: {},
    });
  }
  const reasoning = { ...stReasoningDefaults, ...scenario.reasoning };
  const wi = scenario.worldInfo;
  const books = (names: readonly string[]): LoadedBook[] =>
    names.map((name) => ({ name, entries: wi?.books[name] ?? [] }));
  const common = {
    type: scenario.type,
    card,
    characterKey: scenario.card.name,
    characterTags: [],
    persona,
    chatId: 'st-diff',
    chatMetadata: structuredClone(scenario.chatMetadata ?? {}),
    messages,
    worldInfo: {
      settings: worldInfoSettings({ ...stWorldInfoDefaults, ...wi?.settings }),
      global: books(wi?.global ?? []),
      character: books(wi?.character ? [wi.character] : []),
      chat: null,
      persona: null,
    },
    authorsNote: { allowWIScan: false },
    globalVariables: {},
    tokenizer: tokenizers.count,
    macros,
    stoppingStrings: scenario.stoppingStrings,
    regexScripts,
    attachments: scenarioAttachments(scenario),
    reasoning: {
      addToPrompts: reasoning.add_to_prompts,
      maxAdditions: reasoning.max_additions,
      prefix: reasoning.prefix,
      suffix: reasoning.suffix,
      separator: reasoning.separator,
    },
  };
  if (scenario.text) {
    const { formatting, text } = await textSetup(scenario, tokenizers.ids);
    const power = scenario.text.power ?? {};
    const prepared = await prepareGeneration({
      ...common,
      api: 'text',
      formatting,
      text,
      promptBias: String(power.user_prompt_bias ?? ''),
      pinExamples: Boolean(power.pin_examples),
    });
    return {
      path: new URL(prepared.http.url).pathname,
      body: JSON.parse(prepared.http.body!) as Record<string, unknown>,
    };
  }
  const biasLists = (stPreset.bias_presets ?? {}) as Record<string, { text?: string; value?: number }[]>;
  const prepared = await prepareGeneration({
    ...common,
    preset,
    logitBias: biasLists[String(stPreset.bias_preset_selected)],
    // SillyTavern read the mock's model list.
    modelInfo: mockModelEntry(scenarioModel(scenario)),
    tools: scenario.tools,
    connection: {
      provider: getProvider(provider)!,
      model: scenarioModel(scenario),
      // Custom and the reverse proxies point at the mock; other sources keep their own host.
      baseUrl:
        provider === 'makersuite'
          ? 'http://127.0.0.1:5057'
          : provider === 'custom' || provider === 'claude'
            ? 'http://127.0.0.1:5057/v1'
            : undefined,
      settings: scenario.sourceSettings,
      customBody:
        provider === 'custom'
          ? {
              include: String(scenario.sourceSettings?.custom_include_body ?? ''),
              exclude: String(scenario.sourceSettings?.custom_exclude_body ?? ''),
              headers: String(scenario.sourceSettings?.custom_include_headers ?? ''),
            }
          : undefined,
    },
  });
  return {
    path: new URL(prepared.http.url).pathname,
    body: JSON.parse(prepared.http.body!) as Record<string, unknown>,
  };
}
