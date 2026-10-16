import { joinUrl } from './registry.ts';
import type { HttpRequestSpec, ProviderDefinition } from './types.ts';

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  maxOutput?: number;
  /** The provider's entry as listed (what the model accepts, its tokenizer, ...). */
  entry?: Record<string, unknown>;
}

/** The request that lists a provider's models (`null` when the provider has no listing endpoint). */
export function modelsRequest(provider: ProviderDefinition, baseUrl?: string): HttpRequestSpec | null {
  if (!provider.modelsPath) return null;
  const base = baseUrl || provider.baseUrl;
  if (!base) return null;
  return {
    url: joinUrl(base, provider.modelsPath),
    method: 'GET',
    headers: { ...provider.defaultHeaders },
    auth: provider.auth,
  };
}

/** Normalizes the model list responses of the supported protocol families. */
export function parseModels(provider: ProviderDefinition, body: unknown): ModelInfo[] {
  const json = (body ?? {}) as Record<string, unknown>;
  if (provider.family === 'gemini') {
    const models = (json.models as Record<string, unknown>[] | undefined) ?? [];
    return models
      .filter(
        (m) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          (m.supportedGenerationMethods as string[]).includes('generateContent'),
      )
      .map((m) => ({
        id: String(m.name ?? '').replace(/^models\//, ''),
        name: String(m.displayName ?? m.name ?? ''),
        contextLength: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
        maxOutput: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : undefined,
      }));
  }
  const list = (Array.isArray(json.data) ? json.data : Array.isArray(body) ? body : []) as Record<
    string,
    unknown
  >[];
  return list
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id as string,
      name: String(m.display_name ?? m.name ?? m.id),
      contextLength:
        typeof m.context_length === 'number'
          ? m.context_length
          : typeof m.context_window === 'number'
            ? m.context_window
            : undefined,
      maxOutput:
        typeof (m.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens === 'number'
          ? ((m.top_provider as Record<string, unknown>).max_completion_tokens as number)
          : undefined,
      entry: m,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Convenience: `modelsRequest` + `parseModels` with a request runner (e.g. the server proxy). */
export async function listModels(
  provider: ProviderDefinition,
  run: (spec: HttpRequestSpec) => Promise<unknown>,
  baseUrl?: string,
): Promise<ModelInfo[]> {
  const spec = modelsRequest(provider, baseUrl);
  if (!spec) return [];
  return parseModels(provider, await run(spec));
}
