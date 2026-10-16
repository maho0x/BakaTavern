/**
 * Which tokenizer counts a model's tokens: SillyTavern's `getTokenizerModel` (the browser's choice
 * for Chat Completion, then the server's mapping to a tokenizer) and `getTokenizerBestMatch` for
 * Text Completion.
 */

import type { TokenizerId } from './index.ts';

/** Model metadata some providers report (OpenRouter's `architecture.tokenizer`). */
export interface TokenizerModelInfo {
  tokenizer?: string;
}

/** The tokenizer model name SillyTavern's browser sends for a Chat Completion source. */
export function chatTokenizerModel(source: string, model: string, info?: TokenizerModelInfo): string {
  const m = model ?? '';
  if (source === 'openai') return m;
  if (source === 'azure_openai') return m || 'gpt-3.5-turbo';
  if (source === 'deepseek') return 'deepseek';
  if (source === 'openrouter' && m) {
    switch (info?.tokenizer) {
      case 'Llama2':
        return 'llama';
      case 'Llama3':
        return 'llama3';
      case 'Mistral':
        return 'mistral';
      case 'Yi':
        return 'yi';
      case 'Gemini':
        return 'gemma';
      case 'Qwen':
        return 'qwen2';
      case 'Cohere':
        return m.includes('command-a') ? 'command-a' : 'command-r';
    }
    if (m.includes('gpt-4o')) return 'gpt-4o';
    if (m.includes('gpt-4')) return 'gpt-4';
    if (m.includes('gpt-3.5-turbo')) return 'gpt-3.5-turbo';
    if (m.includes('claude')) return 'claude';
    if (m.includes('GPT-NeoXT')) return 'gpt2';
    if (m.includes('jamba')) return 'jamba';
    if (m.includes('deepseek')) return 'deepseek';
  }
  if (source === 'electronhub' && m) {
    if (m.includes('gpt-4o') || m.includes('gpt-5') || m.includes('gpt-6-astra')) return 'gpt-4o';
    if (m.includes('gpt-4.1') || m.includes('gpt-4.5')) return 'gpt-4o';
    if (m.includes('gpt-4')) return 'gpt-4';
    if (m.includes('gpt-3.5-turbo')) return 'gpt-3.5-turbo';
    if (m.includes('claude')) return 'claude';
    if (m.includes('jamba')) return 'jamba';
    if (m.includes('deepseek') || m.includes('sonar-reasoning') || m.includes('r1')) return 'deepseek';
    if (m.includes('qwen')) return 'qwen2';
    if (m.includes('gemma')) return 'gemma';
    if (m.includes('mistral')) return 'mistral';
    if (m.includes('yi')) return 'yi';
    if (m.includes('llama3') || m.includes('llama-3') || m.startsWith('l3')) return 'llama3';
    if (m.includes('llama')) return 'llama';
    if (m.includes('command-a')) return 'command-a';
    if (m.includes('command-r')) return 'command-r';
    if (m.includes('nemo')) return 'nemo';
  }
  if (source === 'chutes' && m) {
    const l = m.toLowerCase();
    if (l.includes('deepseek') || l.includes('mai-ds')) return 'deepseek';
    if (l.includes('qwen') || l.includes('qwq') || l.includes('tongyi') || l.includes('kimi')) return 'qwen2';
    if (l.includes('llama') || l.includes('longcat') || l.includes('hermes')) return 'llama3';
    if (l.includes('gemma')) return 'gemma';
    if (l.includes('nemo')) return 'nemo';
    if (l.includes('mistral')) return 'mistral';
    if (l.includes('gpt-oss')) return 'gpt-4o';
  }
  if (source === 'minimax') return 'gpt-3.5-turbo';
  if (source === 'workers_ai' && m) {
    const l = m.toLowerCase();
    if (l.includes('deepseek')) return 'deepseek';
    if (l.includes('qwen') || l.includes('qwq') || l.includes('kimi')) return 'qwen2';
    if (l.includes('llama-3') || l.includes('llama-4')) return 'llama3';
    if (l.includes('llama')) return 'llama';
    if (l.includes('gemma')) return 'gemma';
    if (l.includes('mistral')) return 'mistral';
    if (l.includes('phi')) return 'gpt-3.5-turbo';
    if (l.includes('gpt-oss')) return 'gpt-4o';
  }
  if (source === 'cohere') return m.includes('command-a') ? 'command-a' : 'command-r';
  if (source === 'makersuite' || source === 'vertexai') return 'gemma';
  if (source === 'ai21') return 'jamba';
  if (source === 'claude') return 'claude';
  if (source === 'mistralai') return m.includes('nemo') || m.includes('pixtral') ? 'nemo' : 'mistral';
  if (source === 'custom') return m;
  if (source === 'perplexity') {
    if (m.includes('sonar-reasoning') || m.includes('r1-1776')) return 'deepseek';
    if (m.includes('llama-3') || m.includes('llama3')) return 'llama3';
    if (m.includes('llama')) return 'llama';
    if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
  }
  if (source === 'groq') {
    if (m.includes('qwen')) return 'qwen2';
    if (m.includes('llama-3') || m.includes('llama3')) return 'llama3';
    if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
    if (m.includes('gemma')) return 'gemma';
  }
  return 'gpt-3.5-turbo';
}

/** OpenAI's completion-era models, counted with their own encodings. */
const P50K_MODELS = [
  'text-davinci-003',
  'text-davinci-002',
  'code-davinci-002',
  'code-davinci-001',
  'code-cushman-002',
  'code-cushman-001',
];
const R50K_MODELS = [
  'text-davinci-001',
  'text-curie-001',
  'text-babbage-001',
  'text-ada-001',
  'text-similarity-davinci-001',
  'text-similarity-curie-001',
  'text-similarity-babbage-001',
  'text-similarity-ada-001',
  'text-search-davinci-doc-001',
  'text-search-curie-doc-001',
  'text-search-babbage-doc-001',
  'text-search-ada-doc-001',
  'code-search-babbage-code-001',
  'code-search-ada-code-001',
];

/** The tokenizer for a tokenizer model name (SillyTavern's server-side `getTokenizerModel`). */
export function tokenizerForModelName(name: string): TokenizerId {
  const m = name ?? '';
  if (m === 'o1' || m.includes('o1-preview') || m.includes('o1-mini') || m.includes('o3-mini'))
    return 'o200k';
  if (m.includes('gpt-5') || m.includes('gpt-6-astra') || m.includes('o3') || m.includes('o4-mini'))
    return 'o200k';
  if (m.includes('gpt-4o') || m.includes('chatgpt-4o-latest')) return 'o200k';
  if (m.includes('gpt-4.1') || m.includes('gpt-4.5')) return 'o200k';
  if (m.includes('gpt-4') || m.includes('gpt-3.5-turbo')) return 'cl100k';
  if (
    m === 'gpt-3.5-turbo-instruct' ||
    m === 'gpt-3.5-turbo-instruct-0914' ||
    m === 'text-embedding-ada-002'
  ) {
    return 'cl100k';
  }
  if (P50K_MODELS.includes(m) || m === 'text-davinci-edit-001' || m === 'code-davinci-edit-001')
    return 'p50k';
  if (R50K_MODELS.includes(m)) return 'gpt2';
  if (m === 'gpt2') return 'gpt2';
  if (m.includes('claude')) return 'claude';
  if (m.includes('llama3') || m.includes('llama-3')) return 'llama3';
  if (m.includes('llama')) return 'llama';
  if (m.includes('mistral')) return 'mistral';
  if (m.includes('yi')) return 'yi';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('gemma') || m.includes('gemini') || m.includes('learnlm')) return 'gemma';
  if (m.includes('jamba')) return 'jamba';
  if (m.includes('qwen2')) return 'qwen2';
  if (m.includes('command-r')) return 'command-r';
  if (m.includes('command-a')) return 'command-a';
  if (m.includes('nemo')) return 'nemo';
  return 'cl100k';
}

/** The tokenizer SillyTavern counts a Chat Completion prompt with. */
export function chatTokenizer(source: string, model: string, info?: TokenizerModelInfo): TokenizerId {
  return tokenizerForModelName(chatTokenizerModel(source, model, info));
}

/** Text Completion backends that can tokenize (SillyTavern's `TEXTGEN_TOKENIZERS`). */
export const remoteTokenizerTypes = ['ooba', 'tabby', 'koboldcpp', 'llamacpp', 'vllm', 'aphrodite'];

/**
 * SillyTavern's "best match" tokenizer for Text Completion: the backend's own tokenizer when it
 * has one (`'remote'`), otherwise one picked from the model name, Llama's by default.
 */
export function textTokenizer(
  type: string,
  model: string,
  options: { remote?: boolean; info?: TokenizerModelInfo } = {},
): TokenizerId | 'remote' {
  if (options.remote && remoteTokenizerTypes.includes(type)) return 'remote';
  if (type === 'openrouter') {
    if (model.includes('jamba')) return 'jamba';
    switch (options.info?.tokenizer) {
      case 'Llama2':
        return 'llama';
      case 'Llama3':
        return 'llama3';
      case 'Yi':
        return 'yi';
      case 'Mistral':
        return 'mistral';
      case 'Gemini':
        return 'gemma';
      case 'Claude':
        return 'claude';
      case 'Cohere':
        return 'command-r';
      case 'Qwen':
        return 'qwen2';
      default:
        return tokenizerForModelName(model);
    }
  }
  if (type === 'dreamgen') {
    return model.startsWith('lucid-v1-extra-large') || model.startsWith('lucid-v1-max')
      ? 'llama3'
      : 'mistral';
  }
  const m = model.toLowerCase();
  if (m.includes('llama3') || m.includes('llama-3')) return 'llama3';
  if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
  if (m.includes('gemma')) return 'gemma';
  if (m.includes('nemo') || m.includes('pixtral')) return 'nemo';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('yi')) return 'yi';
  if (m.includes('jamba')) return 'jamba';
  if (m.includes('command-r')) return 'command-r';
  if (m.includes('command-a')) return 'command-a';
  if (m.includes('qwen2')) return 'qwen2';
  return 'llama';
}

/** The Text Completion tokenizer setting: SillyTavern's best match, the backend's or one by name. */
export type TextTokenizerSetting = 'auto' | 'remote' | TokenizerId;

/** Tokenizers SillyTavern takes token ids from for Text Completion (`ENCODE_TOKENIZERS`). */
export const encodeTokenizers: readonly TokenizerId[] = [
  'llama',
  'mistral',
  'yi',
  'llama3',
  'gemma',
  'jamba',
  'qwen2',
  'command-r',
  'command-a',
  'nemo',
  'deepseek',
];

/** The tokenizer Text Completion counts with (`power_user.tokenizer`). */
export function textCountTokenizer(
  type: string,
  model: string,
  setting: TextTokenizerSetting,
  info?: TokenizerModelInfo,
): TokenizerId | 'remote' {
  if (setting === 'auto') return textTokenizer(type, model, { remote: true, info });
  // A backend that cannot tokenize leaves the estimate.
  if (setting === 'remote') return remoteTokenizerTypes.includes(type) ? 'remote' : 'estimate';
  return setting;
}

/**
 * The tokenizer for token ids in Text Completion's logit bias and banned tokens (SillyTavern's
 * `getTokenizerForTokenIds`): the backend's own when it can tokenize, whatever the setting, then
 * the chosen tokenizer if it gives ids, then the model's, then Llama's.
 */
export function textIdTokenizer(
  type: string,
  model: string,
  setting: TextTokenizerSetting,
  info?: TokenizerModelInfo,
): TokenizerId | 'remote' {
  const best = textTokenizer(type, model, { remote: true, info });
  if (best === 'remote') return 'remote';
  if (setting !== 'auto' && setting !== 'remote' && encodeTokenizers.includes(setting)) return setting;
  if (type === 'openrouter' || type === 'dreamgen') return best;
  return 'llama';
}

/** SillyTavern's tokenizer setting (`power_user.tokenizer`) by number. */
export const stTokenizerIds: Record<number, TokenizerId | 'auto' | 'remote'> = {
  0: 'estimate',
  1: 'gpt2',
  2: 'auto',
  3: 'llama',
  4: 'nerdstash',
  5: 'nerdstash_v2',
  6: 'remote',
  7: 'mistral',
  8: 'yi',
  9: 'remote',
  10: 'remote',
  11: 'claude',
  12: 'llama3',
  13: 'gemma',
  14: 'jamba',
  15: 'qwen2',
  16: 'command-r',
  17: 'nemo',
  18: 'deepseek',
  19: 'command-a',
  99: 'auto',
};

/** SillyTavern's `power_user.tokenizer` number for a setting (best match when it has none). */
export function stTokenizerNumber(setting: TextTokenizerSetting): number {
  if (setting === 'auto') return 99;
  // tiktoken encodings are SillyTavern's "OpenAI" tokenizer.
  if (setting === 'o200k' || setting === 'cl100k' || setting === 'p50k') return 2;
  const entry = Object.entries(stTokenizerIds).find(([, id]) => id === setting);
  return entry ? Number(entry[0]) : 99;
}

/** SillyTavern's tokenizer names (the `/tokenizer` command's keys) by number. */
export const stTokenizerKeys: Record<string, number> = {
  none: 0,
  gpt2: 1,
  openai: 2,
  llama: 3,
  nerd: 4,
  nerd2: 5,
  api_current: 6,
  mistral: 7,
  yi: 8,
  api_textgenerationwebui: 9,
  api_kobold: 10,
  claude: 11,
  llama3: 12,
  gemma: 13,
  jamba: 14,
  qwen2: 15,
  command_r: 16,
  nemo: 17,
  deepseek: 18,
  command_a: 19,
  best_match: 99,
};

/** The setting for a SillyTavern tokenizer name, `undefined` for unknown names. */
export function fromStTokenizerKey(key: string): TextTokenizerSetting | undefined {
  const number = stTokenizerKeys[key.toLowerCase()];
  return number === undefined ? undefined : stTokenizerIds[number];
}

/** SillyTavern's name for a setting. */
export function stTokenizerKey(setting: TextTokenizerSetting): string {
  const number = stTokenizerNumber(setting);
  return Object.entries(stTokenizerKeys).find(([, n]) => n === number)?.[0] ?? 'best_match';
}
