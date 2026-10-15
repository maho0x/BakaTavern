# BakaTavern

A lighter, faster SillyTavern, rebuilt from scratch and compatible with SillyTavern's data both ways: character cards, chats, presets and lorebooks import directly and export back.

[简体中文说明](README.zh-CN.md)

> Status: in development. Chatting works end to end (milestone M1). Group chats, STscript, the front-end card bridge and the official plugins follow in later milestones.

## Highlights

- **One file to run.** A Rust server with SQLite and the web app embedded. The Docker image is 19.8 MB, ready about 0.1 s after start, about 2 MiB of memory when idle (measured with `docker stats`).
- **Replies are never lost.** Generation runs on the server. Lock your phone, close the tab or reload: the reply is there when you come back, and another device viewing the same chat sees it stream live.
- **Same prompts as SillyTavern.** With the same card, preset and lorebooks, the request sent to the model is identical to SillyTavern 1.19's (see below).
- **Keys stay on the server.** API keys are stored encrypted, never sent to the browser, and only attached to the addresses you allow.
- **In sync everywhere.** Tabs and devices update each other in real time instead of overwriting each other.

## Quick start

```bash
docker build -t bakatavern .
docker run -d -p 8800:8800 -v bakatavern:/data -e BT_PASSWORD=change-me bakatavern
```

Or from source (Node.js 22.18+ with `corepack enable`, and Rust via rustup):

```bash
pnpm install
pnpm build
./target/release/bakatavern serve        # http://127.0.0.1:8800
```

Listening on a non-local address requires a password (`BT_PASSWORD` or `bakatavern passwd`). See [README.zh-CN.md](README.zh-CN.md) for all settings.

## Parity with SillyTavern

`tools/st-diff` runs the same scenarios through SillyTavern 1.19 (in Docker) and BakaTavern and compares the requests sent to the model. All 15 current scenarios match exactly. They cover card fields, example dialogue, personas, character prompt overrides, Author's Note, World Info, continue with and without prefill, impersonation, swipes, names in content, squashed system messages, Claude and Gemini. The recorded SillyTavern requests are checked in, so `pnpm test` verifies them without Docker.

## Development

```bash
pnpm dev:server     # API server on :8800
pnpm dev            # web app dev server on :5173
pnpm mock-llm       # fake OpenAI/Claude/Gemini on :5055
pnpm test           # all unit tests, including the SillyTavern comparison
pnpm e2e            # browser tests against the built app
```

Architecture and conventions: [CLAUDE.md](CLAUDE.md).

## License

[AGPL-3.0](LICENSE), like SillyTavern.
