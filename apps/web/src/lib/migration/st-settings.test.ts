import { describe, expect, it } from 'vitest';

import {
  chatDefaults,
  connectionDefaults,
  formattingDefaults,
  noteDefaults,
  regexDefaults,
  worldInfoDefaults,
  type ConnectionPrefs,
  type RegexPrefs,
  type WorldInfoPrefs,
} from '../state/prefs.ts';
import { mapStSettings, toStSettings, type StImportStash } from './st-settings.ts';

const stash: StImportStash = {
  settings: {
    main_api: 'textgenerationwebui',
    max_context: 16384,
    amount_gen: 512,
    textgenerationwebui_settings: {
      type: 'ollama',
      preset: 'Universal-Light',
      server_urls: { ollama: 'http://192.168.1.20:11434', koboldcpp: 'http://127.0.0.1:5001' },
      ollama_model: 'llama3.1:8b',
      streaming: true,
      temp: 1.25,
      min_p: 0.1,
      openrouter_providers: ['DeepInfra'],
    },
    oai_settings: {
      chat_completion_source: 'openrouter',
      openai_model: 'gpt-4.1',
      openrouter_model: 'anthropic/claude-sonnet-4.5',
      custom_model: 'local-model',
      custom_url: 'http://192.168.1.20:5001/v1',
      custom_include_body: 'top_k: 40',
      claude_model: 'claude-sonnet-4-5',
      zai_endpoint: 'coding',
      openrouter_middleout: 'off',
      openrouter_providers: ['DeepInfra'],
      preset_settings_openai: 'My Preset',
      reverse_proxy: '',
      bias_presets: {
        'Default (none)': [],
        'No bonds': [{ id: 'b1', text: ' bond', value: -50 }, { text: '[1, 2]' }],
      },
    },
    power_user: {
      instruct: { enabled: true, preset: 'ChatML', input_sequence: '<|im_start|>user', wrap: true },
      context: { preset: 'ChatML', story_string: '{{system}}', story_string_position: 0 },
      sysprompt: { enabled: false, name: 'Actor', content: 'Act.', post_history: '' },
      always_force_name2: false,
      single_line: true,
      prefer_character_prompt: false,
      collapse_newlines: true,
      token_padding: 32,
      tokenizer: 12,
      user_prompt_bias: '*',
      custom_stopping_strings: '["\\n{{user}}:", ""]',
      reasoning: {
        auto_parse: true,
        add_to_prompts: true,
        prefix: '<think>\n',
        suffix: '\n</think>',
        separator: '\n\n',
        max_additions: 2,
      },
      persona_descriptions: {
        'user-default.png': {
          description: 'A nurse.',
          connections: [{ type: 'character', id: 'Seraphina.png' }],
        },
      },
    },
    world_info_settings: {
      world_info: { globalSelect: ['Eldoria'], charLore: [{ name: 'Seraphina.png', extraBooks: ['Glade'] }] },
      world_info_depth: 4,
      world_info_budget: 40,
      world_info_recursive: false,
      world_info_character_strategy: 0,
    },
    extension_settings: {
      note: {
        default: '[Be brief.]',
        defaultInterval: 2,
        defaultDepth: 3,
        defaultPosition: 1,
        defaultRole: 0,
        allowWIScan: true,
        chara: [{ name: 'Seraphina.png', prompt: 'Speaks softly.', useChara: true, position: 2 }],
      },
      regex: [{ id: 'r1', scriptName: 'Old display', findRegex: '/x/', replaceString: 'y', placement: [0] }],
      character_allowed_regex: ['Seraphina.png', 'Missing.png'],
      preset_allowed_regex: { openai: ['My Preset'] },
      variables: { global: { mood: '"happy"', count: '3' } },
      connectionManager: {
        selectedProfile: 'p1',
        profiles: [
          {
            id: 'p1',
            name: 'Claude via proxy',
            mode: 'cc',
            api: 'claude',
            preset: 'My Preset',
            model: 'claude-sonnet-4-5',
            proxy: 'Home',
            'secret-id': 'st-key-1',
            'stop-strings': '',
            exclude: [],
          },
          {
            id: 'p2',
            name: 'Kobold',
            mode: 'tc',
            api: 'koboldcpp',
            tokenizer: 'llama3',
            'secret-id': 'gone',
          },
          { id: 'p3', mode: 'cc' },
        ],
      },
    },
    proxies: [{ name: 'Home', url: 'http://192.168.1.2:8080/v1', password: '' }],
  },
  characters: { 'Seraphina.png': 'char-1' },
  personas: { 'user-default.png': 'persona-1' },
  lorebooks: { Eldoria: 'book-1' },
  presets: { 'openai/My Preset': 'preset-1' },
  secrets: [
    { id: 'key-1', provider: 'openrouter', active: true, stId: 'st-key-1' },
    { id: 'key-2', provider: 'custom', active: true },
    { id: 'key-3', provider: 'not-a-provider', active: true },
    { id: 'key-4', provider: 'ollama', active: true },
  ],
  importedAt: 0,
};

describe('mapStSettings', () => {
  const patch = mapStSettings(stash, { regex: regexDefaults });

  it('maps the connection: source, models, URLs, endpoints, keys and the preset', () => {
    expect(patch.connection.providerId).toBe('openrouter');
    expect(patch.connection.models).toMatchObject({
      openai: 'gpt-4.1',
      openrouter: 'anthropic/claude-sonnet-4.5',
      custom: 'local-model',
      claude: 'claude-sonnet-4-5',
    });
    expect(patch.connection.baseUrls).toEqual({ custom: 'http://192.168.1.20:5001/v1' });
    expect(patch.connection.endpoints).toEqual({ zai: 'coding' });
    expect(patch.connection.secretIds).toMatchObject({ openrouter: 'key-1', custom: 'key-2' });
    expect(patch.connection.sourceSettings?.openrouter).toEqual({
      openrouter_middleout: 'off',
      openrouter_providers: ['DeepInfra'],
    });
    expect(patch.connection.customBody?.include).toBe('top_k: 40');
    expect(patch.connection.presetId).toBe('preset-1');
  });

  it('maps chat, reasoning and World Info settings', () => {
    expect(patch.chat).toMatchObject({
      promptBias: '*',
      stoppingStrings: ['\n{{user}}:'],
      reasoningAutoParse: true,
      reasoningAddToPrompts: true,
      reasoningMaxAdditions: 2,
      reasoningSeparator: '\n\n',
    });
    expect(patch.worldinfo.settings).toMatchObject({
      depth: 4,
      budget: 40,
      recursive: false,
      characterStrategy: 0,
    });
    expect(patch.worldinfo.globalBooks).toEqual(['Eldoria']);
    expect(patch.worldinfo.characterExtraBooks).toEqual({ 'char-1': ['Glade'] });
  });

  it("maps Author's Note defaults, character notes and persona locks", () => {
    expect(patch.note).toMatchObject({ defaultPrompt: '[Be brief.]', defaultInterval: 2, allowWIScan: true });
    expect(patch.note.characterNotes).toEqual({
      'char-1': { prompt: 'Speaks softly.', position: 2, enabled: true },
    });
    expect(patch.persona.characterPersona).toEqual({ 'char-1': 'persona-1' });
  });

  it('brings regex scripts up to date and translates who may run embedded ones', () => {
    expect(patch.regex.scripts).toHaveLength(1);
    expect(patch.regex.scripts![0]).toMatchObject({ id: 'r1', markdownOnly: true, promptOnly: true });
    expect(patch.regex.allowedCharacters).toEqual(['char-1']);
    expect(patch.regex.allowedPresets).toEqual(['preset-1']);
    expect(patch.variables).toEqual({ mood: 'happy', count: 3 });
  });

  it('lets imported keys reach their provider or the Custom URL', () => {
    expect(patch.secretOrigins).toEqual([
      { id: 'key-1', origins: ['https://openrouter.ai'] },
      { id: 'key-2', origins: ['http://192.168.1.20:5001'] },
      { id: 'key-4', origins: ['http://192.168.1.20:11434'] },
    ]);
  });

  it('maps Text Completion: backend, address, model, lengths and the samplers in use', () => {
    expect(patch.connection.api).toBe('text');
    expect(patch.connection.text).toMatchObject({
      type: 'ollama',
      serverUrls: { ollama: 'http://192.168.1.20:11434', koboldcpp: 'http://127.0.0.1:5001' },
      models: { ollama: 'llama3.1:8b' },
      streaming: true,
      maxContext: 16384,
      maxResponse: 512,
      settings: { openrouter_providers: ['DeepInfra'] },
    });
    expect(patch.templates.textgen).toEqual({
      name: 'Universal-Light',
      data: { temp: 1.25, min_p: 0.1, genamt: 512, max_length: 16384 },
    });
  });

  it('keeps the formatting templates as SillyTavern used them', () => {
    expect(patch.formatting).toMatchObject({
      instructEnabled: true,
      syspromptEnabled: false,
      preferCharacterPrompt: false,
      collapseNewlines: true,
      tokenPadding: 32,
      tokenizer: 'llama3',
    });
    expect(patch.logitbias.lists?.['No bonds']).toEqual([
      { id: 'b1', text: ' bond', value: -50 },
      { id: expect.any(String), text: '[1, 2]', value: 0 },
    ]);
    expect(patch.templates.instruct).toEqual({
      name: 'ChatML',
      data: { input_sequence: '<|im_start|>user', wrap: true, name: 'ChatML' },
    });
    expect(patch.templates.context?.data).toMatchObject({
      story_string: '{{system}}',
      always_force_name2: false,
      single_line: true,
      trim_sentences: false,
    });
    expect(patch.templates.sysprompt).toEqual({
      name: 'Actor',
      data: { name: 'Actor', content: 'Act.', post_history: '' },
    });
  });
});

describe('connection profiles', () => {
  it('keep SillyTavern’s shape, with proxy addresses and BakaTavern key ids', () => {
    const { profiles } = mapStSettings(stash, { regex: regexDefaults });
    expect(profiles.selected).toBe('p1');
    expect(profiles.profiles?.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(profiles.profiles?.[0]).toMatchObject({
      proxy: 'Home',
      'proxy-url': 'http://192.168.1.2:8080/v1',
      'secret-id': 'key-1',
      'stop-strings': '',
    });
    expect(profiles.profiles?.[1]).not.toHaveProperty('secret-id');
  });
});

describe('toStSettings', () => {
  it('writes settings SillyTavern reads back the same way', () => {
    const patch = mapStSettings(stash, { regex: regexDefaults });
    const names = {
      characters: { 'char-1': 'Seraphina.png' },
      personas: { 'persona-1': 'user-default.png' },
    };
    const exported = toStSettings({
      names,
      connection: { ...connectionDefaults, ...patch.connection } as ConnectionPrefs,
      chat: { ...chatDefaults, ...patch.chat },
      worldinfo: { ...worldInfoDefaults, ...patch.worldinfo } as WorldInfoPrefs,
      note: { ...noteDefaults, ...patch.note },
      persona: { defaultPersonaId: null, characterPersona: patch.persona.characterPersona ?? {} },
      regex: { ...regexDefaults, ...patch.regex } as RegexPrefs,
      variables: patch.variables,
      presetNames: { 'preset-1': 'My Preset' },
      formatting: { ...formattingDefaults, ...patch.formatting },
      logitbias: { lists: patch.logitbias.lists ?? {} },
      profiles: { profiles: patch.profiles.profiles ?? [], selected: patch.profiles.selected ?? null },
      templates: patch.templates,
    });
    const again = mapStSettings({ ...stash, settings: exported, secrets: [] }, { regex: regexDefaults });
    expect(again.connection.providerId).toBe('openrouter');
    expect(again.connection.models).toEqual(patch.connection.models);
    expect(again.connection.presetId).toBe('preset-1');
    expect(again.chat).toEqual(patch.chat);
    expect(again.worldinfo).toEqual(patch.worldinfo);
    expect(again.note).toEqual(patch.note);
    expect(again.persona).toEqual(patch.persona);
    expect(again.regex.allowedCharacters).toEqual(['char-1']);
    expect(again.regex.allowedPresets).toEqual(['preset-1']);
    expect(again.variables).toEqual(patch.variables);
    expect(again.connection.api).toBe('text');
    // Keys are not part of settings.json.
    expect({ ...again.connection.text, secretIds: {} }).toEqual({ ...patch.connection.text, secretIds: {} });
    expect(again.formatting).toEqual(patch.formatting);
    expect(again.templates).toEqual(patch.templates);
    expect(again.logitbias).toEqual(patch.logitbias);
    expect(again.profiles.profiles?.map((p) => p.name)).toEqual(['Claude via proxy', 'Kobold']);
  });
});
