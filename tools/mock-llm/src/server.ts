import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  at: number;
}

export interface MockOptions {
  /** Model ids returned by the model list endpoints. */
  models?: string[];
  /** Milliseconds between streamed chunks. */
  delayMs?: number;
  /** Reply text; defaults to echoing the last user message. Can be changed with POST /__reply. */
  reply?: string;
  /** Replies for the next requests, one each, before `reply` applies again. */
  replies?: string[];
  reasoning?: string;
  /**
   * OpenAI-compatible chats: call this tool (when tools are offered) until the request carries a
   * tool result, then reply as usual.
   */
  toolCall?: { name: string; arguments: Record<string, unknown> } | null;
  /** Files served at their path (`POST /__files` adds them): `{ type, base64 }`. */
  files?: Record<string, { type: string; base64: string }>;
}

function lastUserText(body: Record<string, unknown>): string {
  // Text Completion: the last line of the prompt that has text.
  if (typeof body.prompt === 'string' && !body.messages) {
    const lines = body.prompt.split('\n').filter((l) => l.trim());
    return lines.at(-1)?.trim() ?? '';
  }
  const messages = (body.messages ?? body.contents ?? []) as Record<string, unknown>[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      const parts = (m.content ?? m.parts ?? []) as Record<string, unknown>[];
      return parts.map((p) => String(p.text ?? '')).join('');
    }
  }
  return '';
}

function chunksOf(text: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  const text = Buffer.concat(parts).toString('utf8');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** Text Completion backends' tokenize endpoints. */
export const tokenizePaths = [
  '/api/extra/tokencount',
  '/tokenize',
  '/v1/tokenize',
  '/v1/internal/encode',
  '/v1/token/encode',
];

/** The mock's tokenizer: one token per word, the id from the word's length. */
export function mockTokenIds(text: string): number[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => 1000 + word.length);
}

/** A model as the mock lists it: enough of OpenRouter's and Mistral's fields for clients that read them. */
export function mockModelEntry(id: string) {
  return {
    id,
    object: 'model',
    name: id,
    context_length: 128000,
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    top_provider: { context_length: 128000, max_completion_tokens: 8192 },
    supported_parameters: ['tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens'],
    capabilities: { function_calling: true },
  };
}

export function createMockServer(options: MockOptions = {}): {
  server: Server;
  requests: RecordedRequest[];
  state: MockOptions;
  /** The request handler, to serve the same mock on another listener (e.g. HTTPS). */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const requests: RecordedRequest[] = [];
  const state: MockOptions = { delayMs: 15, ...options };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = (await readBody(req)) as Record<string, unknown> | null;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === '/__requests') {
      if (req.method === 'DELETE') requests.length = 0;
      return send(200, requests);
    }
    if (url.pathname === '/__files' && req.method === 'POST') {
      state.files = { ...state.files, ...(body as MockOptions['files']) };
      return send(200, Object.keys(state.files ?? {}));
    }
    const served = req.method === 'GET' ? state.files?.[url.pathname] : undefined;
    if (served) {
      res.writeHead(200, { 'content-type': served.type });
      res.end(Buffer.from(served.base64, 'base64'));
      return;
    }
    if (url.pathname === '/__reply' && req.method === 'POST') {
      Object.assign(state, body ?? {});
      return send(200, state);
    }
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      headers: req.headers,
      body,
      at: Date.now(),
    });

    const modelIds = () => (state.models?.length ? state.models : ['mock-model', 'mock-model-large']);
    // Text Completion backends' status endpoints
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      return send(200, { models: modelIds().map((name) => ({ name, model: name, size: 1 })) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/model/list') {
      return send(200, { object: 'list', data: modelIds().map((id) => ({ id, object: 'model' })) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/model') {
      return send(200, { id: modelIds()[0], object: 'model' });
    }
    if (req.method === 'GET' && url.pathname === '/props') {
      return send(200, { chat_template: '', default_generation_settings: { n_ctx: 8192 } });
    }
    if (req.method === 'GET' && url.pathname === '/api/extra/version') {
      return send(200, { result: 'KoboldCpp', version: '1.99' });
    }
    if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
      if (url.pathname.includes('v1beta')) {
        return send(200, {
          models: [
            {
              name: 'models/mock-gemini',
              displayName: 'Mock Gemini',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        });
      }
      return send(200, { object: 'list', data: modelIds().map(mockModelEntry) });
    }
    // Text Completion backends' tokenizers
    const tokenIds = () => mockTokenIds(String(body?.text ?? body?.prompt ?? body?.content ?? ''));
    if (req.method === 'POST' && url.pathname === '/api/extra/tokencount') {
      const ids = tokenIds();
      return send(200, { value: ids.length, ids });
    }
    if (req.method === 'POST' && tokenizePaths.includes(url.pathname)) {
      const tokens = tokenIds();
      return send(200, { tokens, length: tokens.length });
    }
    if (req.method !== 'POST' || !body)
      return send(404, { error: { message: `no mock for ${req.method} ${url.pathname}` } });

    const text = state.replies?.shift() ?? state.reply ?? `Echo: ${lastUserText(body)}`;
    const reasoning = state.reasoning ?? '';
    const stream = Boolean(body.stream) || url.pathname.includes('streamGenerateContent');
    const write = async (chunk: string) => {
      res.write(chunk);
      if (state.delayMs) await sleep(state.delayMs);
    };

    // Anthropic Messages API
    if (url.pathname.endsWith('/messages')) {
      if (!stream) {
        return send(200, {
          type: 'message',
          role: 'assistant',
          content: [
            ...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []),
            { type: 'text', text },
          ],
          stop_reason: 'end_turn',
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      await write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { role: 'assistant' } })}\n\n`,
      );
      if (reasoning) {
        for (const c of chunksOf(reasoning)) {
          await write(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: c } })}\n\n`,
          );
        }
      }
      for (const c of chunksOf(text)) {
        await write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } })}\n\n`,
        );
      }
      await write(
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`,
      );
      res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      return;
    }

    // Gemini
    if (url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent')) {
      const candidate = (t: string, thought = false) => ({
        candidates: [
          { content: { role: 'model', parts: [{ text: t, ...(thought ? { thought: true } : {}) }] } },
        ],
      });
      if (!stream) return send(200, candidate(text));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (reasoning)
        for (const c of chunksOf(reasoning)) await write(`data: ${JSON.stringify(candidate(c, true))}\n\n`);
      for (const c of chunksOf(text)) await write(`data: ${JSON.stringify(candidate(c))}\n\n`);
      res.end();
      return;
    }

    // Ollama: newline-delimited JSON
    if (url.pathname.endsWith('/api/generate')) {
      if (!stream)
        return send(200, { model: body.model, response: text, thinking: reasoning || undefined, done: true });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (reasoning)
        for (const c of chunksOf(reasoning)) await write(`${JSON.stringify({ thinking: c, done: false })}\n`);
      for (const c of chunksOf(text)) await write(`${JSON.stringify({ response: c, done: false })}\n`);
      res.end(`${JSON.stringify({ response: '', done: true, done_reason: 'stop' })}\n`);
      return;
    }

    // llama.cpp native completion
    if (url.pathname.endsWith('/completion')) {
      if (!stream) return send(200, { content: text, stop: true, stop_type: 'eos' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunksOf(text))
        await write(`data: ${JSON.stringify({ content: c, stop: false, index: 0 })}\n\n`);
      res.end(`data: ${JSON.stringify({ content: '', stop: true, stop_type: 'eos', index: 0 })}\n\n`);
      return;
    }

    // OpenAI-style text completions (and OpenRouter's prompt requests on the chat endpoint)
    if (url.pathname.endsWith('/completions') && typeof body.prompt === 'string' && !body.messages) {
      const choice = (t: string, finish: string | null = null, r = '') => ({
        id: 'mock',
        object: 'text_completion',
        choices: [{ index: 0, text: t, finish_reason: finish, ...(r ? { reasoning: r } : {}) }],
      });
      if (!stream) return send(200, choice(text, 'stop', reasoning));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (reasoning)
        for (const c of chunksOf(reasoning)) await write(`data: ${JSON.stringify(choice('', null, c))}\n\n`);
      for (const c of chunksOf(text)) await write(`data: ${JSON.stringify(choice(c))}\n\n`);
      await write(`data: ${JSON.stringify(choice('', 'stop'))}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }

    // OpenAI-compatible chat completions
    const messages = (body.messages ?? []) as { role?: string }[];
    if (state.toolCall && Array.isArray(body.tools) && messages.at(-1)?.role !== 'tool') {
      const call = {
        id: `call_${requests.length}`,
        type: 'function',
        function: { name: state.toolCall.name, arguments: JSON.stringify(state.toolCall.arguments) },
      };
      if (!stream) {
        return send(200, {
          id: 'mock',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [call] },
              finish_reason: 'tool_calls',
            },
          ],
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const args = call.function.arguments;
      await write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: 'function',
              function: { name: call.function.name, arguments: '' },
            },
          ],
        }),
      );
      for (const part of chunksOf(args))
        await write(chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
      await write(chunk({}, 'tool_calls'));
      res.end('data: [DONE]\n\n');
      return;
    }
    if (!stream) {
      return send(200, {
        id: 'mock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: 'stop',
          },
        ],
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (reasoning) for (const c of chunksOf(reasoning)) await write(frame({ reasoning_content: c }));
    for (const c of chunksOf(text)) await write(frame({ content: c }));
    await write(frame({}, 'stop'));
    res.end('data: [DONE]\n\n');
  };

  return { server: createServer(handler), requests, state, handler };
}
