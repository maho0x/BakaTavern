import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  at: number;
}

export interface MockOptions {
  /** Milliseconds between streamed chunks. */
  delayMs?: number;
  /** Reply text; defaults to echoing the last user message. Can be changed with POST /__reply. */
  reply?: string;
  reasoning?: string;
}

function lastUserText(body: Record<string, unknown>): string {
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

export function createMockServer(options: MockOptions = {}): {
  server: Server;
  requests: RecordedRequest[];
  state: MockOptions;
} {
  const requests: RecordedRequest[] = [];
  const state: MockOptions = { delayMs: 15, ...options };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      return send(200, {
        object: 'list',
        data: [
          { id: 'mock-model', object: 'model' },
          { id: 'mock-model-large', object: 'model' },
        ],
      });
    }
    if (req.method !== 'POST' || !body)
      return send(404, { error: { message: `no mock for ${req.method} ${url.pathname}` } });

    const text = state.reply ?? `Echo: ${lastUserText(body)}`;
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

    // OpenAI-compatible chat completions
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
  });

  return { server, requests, state };
}
