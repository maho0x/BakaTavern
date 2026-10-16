import type { ProviderDefinition } from './types.ts';

const bearer = { type: 'bearer' } as const;
const openaiCompat = (
  def: Omit<ProviderDefinition, 'family' | 'auth' | 'modelsPath' | 'keyRequired'> &
    Partial<ProviderDefinition>,
): ProviderDefinition => ({
  family: 'openai-chat',
  auth: bearer,
  modelsPath: '/models',
  keyRequired: true,
  samplers: { penalties: true, seed: true, logitBias: true, n: true },
  reasoning: 'none',
  ...def,
});

/**
 * Chat Completion sources. Ids match SillyTavern's `chat_completion_source` values so imported
 * settings and connection profiles keep working.
 */
export const providers: ProviderDefinition[] = [
  openaiCompat({
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: 'openai',
    defaultModel: 'gpt-5.6-terra',
    maxCompletionTokensModels: /^(o\d|gpt-5|gpt-6|chatgpt-5)/,
  }),
  {
    id: 'claude',
    name: 'Anthropic Claude',
    family: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: { type: 'header', name: 'x-api-key' },
    modelsPath: '/models',
    keyRequired: true,
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    defaultModel: 'claude-sonnet-5',
  },
  {
    id: 'makersuite',
    name: 'Google AI Studio',
    family: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiVersion: 'v1beta',
    auth: { type: 'header', name: 'x-goog-api-key' },
    modelsPath: '/v1beta/models?pageSize=1000',
    keyRequired: true,
    defaultModel: 'gemini-3.7-flash',
  },
  openaiCompat({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    samplers: {
      topK: true,
      minP: true,
      topA: true,
      repetitionPenalty: true,
      penalties: true,
      seed: true,
      logitBias: true,
      n: true,
    },
    reasoning: 'openrouter',
    reasoningField: 'reasoning',
    defaultHeaders: { 'HTTP-Referer': 'https://bakatavern.app', 'X-Title': 'BakaTavern' },
    defaultModel: 'openrouter/auto',
  }),
  openaiCompat({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/beta',
    reasoning: 'openai',
    reasoningField: 'reasoning_content',
    defaultModel: 'deepseek-v4-flash',
  }),
  openaiCompat({
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    keyRequired: false,
    // As SillyTavern: other samplers go through "additional parameters" (extraBody).
    samplers: { penalties: true, seed: true, logitBias: true, n: true },
    reasoning: 'openai',
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({
    id: 'mistralai',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  }),
  openaiCompat({
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    reasoning: 'openai',
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({ id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' }),
  openaiCompat({
    id: 'perplexity',
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    modelsPath: undefined,
  }),
  openaiCompat({
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({
    id: 'zai',
    name: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    endpoints: { common: 'https://api.z.ai/api/paas/v4', coding: 'https://api.z.ai/api/coding/paas/v4' },
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    endpoints: { global: 'https://api.siliconflow.com/v1', cn: 'https://api.siliconflow.cn/v1' },
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    endpoints: { global: 'https://api.minimax.io/v1', cn: 'https://api.minimaxi.com/v1' },
  }),
  openaiCompat({
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({
    id: 'chutes',
    name: 'Chutes',
    baseUrl: 'https://llm.chutes.ai/v1',
    reasoningField: 'reasoning_content',
  }),
  openaiCompat({
    id: 'nanogpt',
    name: 'NanoGPT',
    baseUrl: 'https://nano-gpt.com/api/v1',
    reasoningField: 'reasoning',
  }),
  openaiCompat({ id: 'electronhub', name: 'Electron Hub', baseUrl: 'https://api.electronhub.ai/v1' }),
  openaiCompat({ id: 'aimlapi', name: 'AI/ML API', baseUrl: 'https://api.aimlapi.com/v1' }),
  openaiCompat({ id: 'cometapi', name: 'CometAPI', baseUrl: 'https://api.cometapi.com/v1' }),
  openaiCompat({
    id: 'pollinations',
    name: 'Pollinations',
    baseUrl: 'https://gen.pollinations.ai/v1',
    endpoints: {
      authenticated: 'https://gen.pollinations.ai/v1',
      anonymous: 'https://text.pollinations.ai/v1',
    },
  }),
  // SillyTavern uses Cohere's own v2 chat API; models are listed by v1.
  openaiCompat({
    id: 'cohere',
    name: 'Cohere',
    family: 'cohere',
    baseUrl: 'https://api.cohere.ai/v2',
    modelsPath: '../v1/models',
  }),
  openaiCompat({ id: 'ai21', name: 'AI21', baseUrl: 'https://api.ai21.com/studio/v1' }),
];

export function getProvider(id: string): ProviderDefinition | undefined {
  return providers.find((p) => p.id === id);
}

/** Origins a key for this provider may be sent to (used when saving a key). */
export function providerOrigins(provider: ProviderDefinition, baseUrl?: string): string[] {
  const urls = [baseUrl || provider.baseUrl, ...Object.values(provider.endpoints ?? {})].filter(Boolean);
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // ignore invalid URLs
    }
  }
  return [...origins];
}

/** Joins a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  // `../v1/models` and the like resolve against the base.
  if (path.startsWith('.')) return new URL(path, `${base.replace(/\/+$/, '')}/`).toString();
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
