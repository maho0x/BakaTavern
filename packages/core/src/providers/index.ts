import { anthropic } from './anthropic.ts';
import { gemini } from './gemini.ts';
import { openAIChat, openAIDecoderFor } from './openai-chat.ts';
import type { ProviderAdapter, ProviderDefinition } from './types.ts';

export * from './types.ts';
export * from './registry.ts';
export { SseParser, NdjsonParser } from './sse.ts';
export { buildOpenAIBody } from './openai-chat.ts';
export { buildClaudeBody, convertClaudeMessages } from './anthropic.ts';
export { buildGeminiBody, convertGeminiMessages } from './gemini.ts';
export { listModels, modelsRequest, parseModels, type ModelInfo } from './models.ts';

export function adapterFor(provider: ProviderDefinition): ProviderAdapter {
  switch (provider.family) {
    case 'anthropic':
      return anthropic;
    case 'gemini':
      return gemini;
    default:
      return { ...openAIChat, createDecoder: () => openAIDecoderFor(provider.reasoningField) };
  }
}
