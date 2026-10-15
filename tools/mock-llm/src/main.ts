#!/usr/bin/env node
import { createMockServer } from './server.ts';

const port = Number(process.env.MOCK_LLM_PORT ?? process.argv[2] ?? 5055);
const { server } = createMockServer({ delayMs: Number(process.env.MOCK_LLM_DELAY ?? 20) });
server.listen(port, '127.0.0.1', () => {
  console.log(`mock LLM listening on http://127.0.0.1:${port}`);
  console.log('  OpenAI:  POST /v1/chat/completions    Claude: POST /v1/messages');
  console.log('  Gemini:  POST /v1beta/models/<m>:streamGenerateContent');
  console.log('  Inspect: GET /__requests   Set reply: POST /__reply {"reply": "...", "reasoning": "..."}');
});
