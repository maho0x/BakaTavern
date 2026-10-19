# BakaTavern: notes for contributors and coding agents

BakaTavern rewrites SillyTavern (ST) as a Rust server plus a Svelte 5 web app, keeping ST's behavior and data formats. The reference is **SillyTavern 1.19.0**. Milestones (see the roadmap in `README.zh-CN.md`): M1, the chat MVP, is done; M2, prompt-engine parity (Text Completion, regex, full World Info editor, tokenizers, attachments, tool calling, whole-directory migration), is done but for a few providers; M3 (group chats, STscript and Quick Replies, plugin API v1, the TavernHelper bridge for front-end cards, chat search, backgrounds, themes, tag folders, batch edit, home page) is done; M4 brings the official plugins.

## Architecture rules

1. **All domain logic is TypeScript in `packages/core`**: prompt building, World Info, macros, provider protocols, tokenizers, generation orchestration. Core has no DOM dependencies and is mostly pure functions.
2. **Rust stays thin** (`crates/`): storage, files, auth, the outgoing proxy, durable generation jobs, import/export of ST files. Rust does not interpret prompts or provider protocols. If a change needs domain knowledge, it belongs in core.
3. **ST formats only at the edges.** Inside, data lives in SQLite (see `crates/bt-store/migrations`). ST documents that ST defines (card JSON, presets, lorebook entries, chat metadata, message `extra`) are stored verbatim as JSON so that export is lossless.
4. **Secrets never reach the browser.** Keys are encrypted at rest and attached by the server only to their `allowed_origins`.
5. **Front-end code stays sandboxed.** Message pages and TavernHelper scripts run in iframes without the page's origin (`sandbox="allow-scripts …"`) and reach the app only through `packages/th-bridge` (postMessage RPC plus a copy of the chat state for TavernHelper's synchronous functions). Only a character the user explicitly trusts gets an unsandboxed frame. Plugins run in the page, so they are installed only after the user grants the permissions they list.
6. **Parity is measured, not assumed.** Behavior that affects what is sent to the model must match ST 1.19; see "Prompt parity" below.

## Layout

```
crates/bt-store     SQLite schema, migrations, repositories, content-addressed blobs
crates/bt-formats   ST formats: PNG/CHARX cards, chat JSONL, lorebooks, dates
crates/bt-server    axum routes, auth, SSE change events, LLM proxy + durable jobs, embedded web app,
                    SillyTavern folder import/export (st_import.rs, st_export.rs)
crates/bt-cli       the `bakatavern` binary (serve, passwd, import-st)
packages/core       domain engine (see rule 1)
packages/api-client typed HTTP client; types generated from Rust with ts-rs (src/generated)
packages/th-bridge  TavernHelper (酒馆助手) API for front-end cards: frame runtime (built into dist/th-runtime.js),
                    page-side host, documents for message pages and scripts
packages/plugin-api plugin SDK types and definePlugin (the contract apps/web/src/lib/plugins implements)
apps/web            Svelte 5 SPA (runes, no SvelteKit, no Tailwind; CSS tokens in app.css)
tools/mock-llm      scriptable OpenAI/Claude/Gemini mock that records requests
tools/e2e           Playwright tests against the real binary, built app and mock
tools/st-diff       differential tests against SillyTavern 1.19 in Docker
fixtures/st         ST sample data used by tests
```

## Commands

```bash
pnpm install
pnpm dev:server              # Rust server on 127.0.0.1:8800 (data in ./data)
pnpm dev                     # Vite dev server on :5173, proxies /api to :8800
pnpm mock-llm                # mock model API on :5055 (Custom provider, base URL http://127.0.0.1:5055/v1)

pnpm test                    # TS unit tests (incl. st-diff baselines) + cargo test
pnpm typecheck               # tsc / svelte-check in every package
pnpm lint                    # eslint + clippy -D warnings
pnpm exec prettier --check . && cargo fmt --all --check

pnpm --filter @bakatavern/web build && cargo build -p bt-cli && pnpm e2e
pnpm st-diff:record [scenario-id ...]   # re-record ST requests (needs Docker)
pnpm st-diff:record-stscript            # re-record STscript results in ST (needs Docker)
pnpm --filter @bakatavern/th-bridge build  # frame runtime; the web dev/build scripts run it first
pnpm bindings                # regenerate TS types after changing Rust API types
```

Playwright needs a Chromium. Where its download is blocked, install one (e.g. Debian's `chromium-headless-shell`) and set `PW_CHROMIUM_PATH=/usr/lib/chromium/chromium-headless-shell`.

## Conventions

- **Toolchain**: pnpm 12 workspace, TypeScript 6.0 everywhere (svelte-check and typescript-eslint do not support TS 7 yet), Node 22.18+ (type stripping: `node file.ts` runs TS directly), Rust per `rust-toolchain.toml`, edition 2024.
- **API types**: Rust structs deriving `ts_rs::TS` are the source of truth. After changing them run `pnpm bindings`; never edit `packages/api-client/src/generated`.
- **HTTP API**: JSON errors are `{ "error": { "code", "message", "rev"? } }`. Writes require the `x-bt-client: 1` header (CSRF). Every entity has a `rev` for optimistic concurrency; send it back on updates and handle `409 conflict`. Tabs identify themselves with `x-bt-client-id` (kept per tab in sessionStorage) so they can ignore their own change events.
- **Schema**: until the first release, `0001_init.sql` may still change; after it, add numbered migration files and never edit applied ones.
- **Generation jobs**: the client chooses the job id, so Stop works before the provider answers. A finished job must be claimed (`POST /api/llm/jobs/{id}/claim`) before its result is stored, so that several tabs never save the same reply twice.
- **Prompt logs**: when a generation starts, the web app stores core's `itemizePrompt` result under the chat and the reply's `gen_started` (`POST /api/chats/{id}/prompts`); the prompt viewer reads it back by that key. Nothing BakaTavern-specific is added to messages, so ST exports stay clean.
- **UI text**: every string goes through `t()`. Add each key to both `apps/web/src/lib/i18n/en.ts` and `zh-CN.ts`. Chinese text uses the community's terms: 角色卡, 世界书, 预设, 作者注释, 人设, 开场白, 思维链.
- **Insecure contexts**: users open the app over plain HTTP on the LAN, so do not rely on `crypto.randomUUID`, `navigator.clipboard` or other secure-context APIs without a fallback (see `randomId`, `uuidv4`, `copyText`).
- **Rendering**: message HTML goes through `renderMessage` (marked + DOMPurify) only.
- **No `eval`**: story strings are rendered by core's interpreter over Handlebars' AST (`prompt/handlebars.ts`, tested against `Handlebars.compile`), so a strict CSP stays possible.
- **Style**: Prettier (single quotes, width 110) and rustfmt; match the surrounding code's comment density and naming.

## Prompt parity

`tools/st-diff/src/scenarios.ts` defines scenarios. `pnpm st-diff:record` writes each one as an ST data directory, runs ST 1.19 in Docker, triggers the generation in headless Chromium and stores the request ST sent into `tools/st-diff/baseline/<id>.json`. `pnpm test` then builds the same request with core and requires it to be identical.

STscript has its own cases (`tools/st-diff/src/stscript-cases.ts`): `pnpm st-diff:record-stscript` runs each script in ST 1.19 and stores its result and side effects in `baseline/stscript.json`; `pnpm test` runs them with core's interpreter and requires the same. Commands that act on the app (chat, generation, World Info, …) live in `apps/web/src/lib/stscript/commands` and are covered by e2e tests.

Scenarios with a `text` field use Text Completion: a backend type, settings and SillyTavern's own templates (vendored in `packages/core/src/prompt/st-templates.json`).

Token counts use the tokenizer ST picks for the scenario: for Chat Completion the model's (tiktoken encodings need no files; the others read theirs from `BT_TOKENIZERS_DIR` and otherwise fall back to the estimate, so scenarios that depend on counts use OpenAI-family models), for Text Completion `power.tokenizer` (default 0, the estimate; 1 is GPT-2). Scenarios can add files to ST's user folder (`files`, for attachments) and register function tools in ST (`tools`); the harness reads the same files and passes the mock's model list entry (`mockModelEntry`) as the model info. Backends that can tokenize send ST to the mock's tokenizer (one token per word, `mockTokenIds`), which the harness uses too. ST's UI clamps some settings to its slider ranges, e.g. `openai_max_context` to at least 512; stay inside them.

When you change anything that affects requests (prompt assembly, World Info, macros, provider bodies), run the parity tests. When you port a new ST feature, add a scenario that exercises it and record its baseline. When a scenario fails, ST's behavior is the reference: read the ST source (`public/scripts/openai.js`, `world-info.js`, `macros/`, `src/endpoints/backends/chat-completions.js`; for Text Completion `public/script.js` `Generate()`, `instruct-mode.js`, `power-user.js`, `textgen-settings.js` and `src/endpoints/backends/text-completions.js`) rather than adjusting the baseline. SillyTavern's quirks are kept on purpose (e.g. `Name:Name:` when continuing without instruct mode).

## Testing expectations

- Rust: unit tests next to the code, HTTP-level tests in `crates/bt-server/tests/api.rs` (in-memory router, temp data dir).
- Core: vitest next to the code.
- UI flows: Playwright in `tools/e2e` (desktop and phone viewports; tests share one server, so use unique names via `uniqueName`).
- Format round trips: realistic ST files in `fixtures/st`; exports must equal the input as JSON.
