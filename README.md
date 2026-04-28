# Coordination Games model harness

Standalone local E2E harness for running scripted or OpenAI-compatible model agents against a local Coordination Games server.

The harness creates ephemeral wallet-backed bots, starts a lobby, joins the bots, polls player state, asks a provider for chat/DM/action decisions, publishes reasoning and chat relay messages, submits legal actions, and prints final spectator/inspector links plus message counts.

## Requirements

- Node.js 20+
- A local Coordination Games server exposing the player/lobby/tool/admin inspect APIs
- For MiniMax/OpenAI-compatible runs, an API key exported in your shell

The server, not this harness, owns trust evidence publishing. If you want Lighthouse/IPFS records, start the Worker with its trust publishing env configured there.

This repo intentionally stays small: it is a local simulation client for Lucian's Coordination Games branch, not a fork of the whole game/server stack.

## Install

```bash
npm install
```

## Scripted smoke run

```bash
PROVIDER=scripted \
GAME_SERVER=http://127.0.0.1:8787 \
BOT_CONFIG=examples/tragedy-bots.example.json \
HARNESS_ROUNDS=1 \
HARNESS_COMMUNICATION_SWEEPS=0 \
npm run harness:model
```

## MiniMax run

```bash
export MINIMAX_API_KEY=<your-key>

PROVIDER=minimax \
OPENAI_BASE_URL=https://api.minimax.io/v1 \
MODEL=MiniMax-M2.7-highspeed \
GAME_SERVER=http://127.0.0.1:8787 \
BOT_CONFIG=examples/tragedy-bots.example.json \
HARNESS_ROUNDS=12 \
HARNESS_COMMUNICATION_SWEEPS=1 \
npm run harness:model
```

## Bot configuration

Set `BOT_CONFIG` to a JSON file so you can tweak local bot names, personas, and speech style without touching Lucian's repo:

```bash
BOT_CONFIG=examples/tragedy-bots.example.json npm run harness:model
```

The file can be either `{ "bots": [...] }` or a raw array. Each bot supports:

- `name`
- `id`
- `title`
- `instruction`
- `publicStyle`
- `privateStyle`

By default the harness appends a wallet suffix to each bot name to avoid local name collisions. Set `APPEND_ADDRESS_SUFFIX=false` if you need exact fixed names.

## Environment

See `.env.example` for the full set of options. Important defaults:

- `GAME_SERVER=http://127.0.0.1:8787`
- `WEB_BASE_URL=http://127.0.0.1:5173`
- `GAME_TYPE=tragedy-of-the-commons`
- `INSPECTOR_TOKEN=local-inspector-token`
- `PROVIDER=scripted`

## Current scope

This repository is intentionally still Tragedy-of-the-Commons-specific: the prompts and valid action schemas are tuned for `tragedy-of-the-commons`. The platform boundary is decoupled from the Coordination Games monorepo, but the target server must still implement the Coordination Games HTTP API.

No secrets belong in this repo. Export keys in your shell or use an ignored local env loader.
