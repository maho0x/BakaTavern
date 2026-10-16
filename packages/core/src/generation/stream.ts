import type { StreamDecoder, StreamDelta } from '../providers/types.ts';
import { ToolCallCollector, toolCallsOf, type ModelToolCall } from '../tools.ts';

export interface GenerationOutput {
  text: string;
  reasoning: string;
  signature?: string;
  finishReason?: string;
  error?: string;
  usage?: Record<string, unknown>;
  /** Tool calls the model made. */
  toolCalls?: ModelToolCall[];
}

/** Folds deltas into the running output. */
export function applyDelta(output: GenerationOutput, delta: StreamDelta): GenerationOutput {
  if (delta.text) output.text += delta.text;
  if (delta.reasoning) output.reasoning += delta.reasoning;
  if (delta.signature) output.signature = (output.signature ?? '') + delta.signature;
  if (delta.finishReason) output.finishReason = delta.finishReason;
  if (delta.error) output.error = delta.error;
  if (delta.usage) output.usage = delta.usage;
  return output;
}

/**
 * Reads a streamed response body through a provider decoder. `onUpdate` is called at most once
 * per animation-sized batch of chunks with the accumulated output.
 */
export async function consumeStream(
  body: ReadableStream<Uint8Array>,
  decoder: StreamDecoder,
  onUpdate: (output: GenerationOutput, bytesRead: number) => void,
  signal?: AbortSignal,
): Promise<GenerationOutput> {
  const output: GenerationOutput = { text: '', reasoning: '' };
  const tools = new ToolCallCollector();
  const apply = (delta: StreamDelta) => {
    if (delta.event) tools.push(delta.event);
    applyDelta(output, delta);
  };
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      for (const delta of decoder.push(value)) apply(delta);
      onUpdate(output, bytes);
    }
    for (const delta of decoder.end()) apply(delta);
  } finally {
    reader.releaseLock();
  }
  const calls = tools.calls.length ? toolCallsOf(tools.calls) : [];
  if (calls.length) output.toolCalls = calls;
  return output;
}
