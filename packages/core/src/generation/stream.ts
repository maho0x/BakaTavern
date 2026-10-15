import type { StreamDecoder, StreamDelta } from '../providers/types.ts';

export interface GenerationOutput {
  text: string;
  reasoning: string;
  signature?: string;
  finishReason?: string;
  error?: string;
  usage?: Record<string, unknown>;
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
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      for (const delta of decoder.push(value)) applyDelta(output, delta);
      onUpdate(output, bytes);
    }
    for (const delta of decoder.end()) applyDelta(output, delta);
  } finally {
    reader.releaseLock();
  }
  return output;
}
