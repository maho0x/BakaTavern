import { anthropic } from './anthropic.ts';
import { cohere } from './cohere.ts';
import { gemini } from './gemini.ts';
import { openAIChat, openAIDecoderFor } from './openai-chat.ts';
import type { ProviderAdapter, ProviderDefinition } from './types.ts';

export * from './types.ts';
export * from './registry.ts';
export { SseParser, NdjsonParser } from './sse.ts';
export { buildOpenAIBody, buildOpenAIRequest, settingsFromParams } from './openai-chat.ts';
export {
  chatGenerateData,
  chatStreams,
  chatUpstream,
  defaultChatSourceSettings,
  excludeFromYaml,
  includeFromYaml,
  reasoningEffortFor,
  supportsLogitBias,
  type ChatSettings,
} from './st-chat.ts';
export { buildClaudeBody, convertClaudeMessages } from './anthropic.ts';
export { buildGeminiBody, convertGeminiMessages } from './gemini.ts';
export { listModels, modelsRequest, parseModels, type ModelInfo } from './models.ts';
export * from './textgen.ts';

export function adapterFor(provider: ProviderDefinition): ProviderAdapter {
  switch (provider.family) {
    case 'anthropic':
      return anthropic;
    case 'gemini':
      return gemini;
    case 'cohere':
      return cohere;
    default:
      return { ...openAIChat, createDecoder: () => openAIDecoderFor(provider.reasoningField) };
  }
}
