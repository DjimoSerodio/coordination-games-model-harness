# Coordination Games model harness

Standalone local E2E harness for running scripted or OpenAI-compatible model agents against a local Coordination Games server.

The harness creates ephemeral wallet-backed bots, starts a lobby, joins the bots, polls player state, asks a provider for chat/DM/action decisions, publishes reasoning and chat relay messages, submits legal actions, and writes run artifacts plus final spectator/inspector links and message counts.

This repository is the internal lab bench for hardening Coordination Games and running repeatable model/persona/trust-plugin experiments. It should not become the mandatory future interface for outside teams or bring-your-own-agent participants.

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
HARNESS_RESULTS_DIR=runs/model-harness \
npm run harness:model
```

## Run artifacts and research controls

Each run writes non-secret artifacts under `runs/model-harness/<run-id>/` unless `HARNESS_ARTIFACTS=0` is set:

- `run.config.json` - resolved non-secret run configuration.
- `games.jsonl` - lobby/game lifecycle events.
- `turns.jsonl` - model decisions, submitted actions, and fallback outcomes.
- `errors.jsonl` - provider/action errors with redacted sensitive text.
- `summary.json` - final run summary and spectator/inspector URLs.
- `costs.json` - observed token usage plus optional estimated USD cost.

Useful knobs:

```bash
HARNESS_RUN_ID=my-local-run          # optional; sanitized before use
HARNESS_MODEL_TIMEOUT_MS=90000      # per model call
HARNESS_MODEL_RETRIES=1             # retry provider failures/timeouts
HARNESS_MAX_COST_USD=5              # optional hard stop when rates are set
HARNESS_PROMPT_USD_PER_1M=0.15      # optional estimate only
HARNESS_COMPLETION_USD_PER_1M=0.60  # optional estimate only
```

Artifacts intentionally exclude provider API keys, inspector tokens, bot bearer tokens, and wallet private keys.

## Local GUI configurator

Start the local-only browser configurator:

```bash
npm run gui
```

Then open:

```text
http://127.0.0.1:4317
```

The GUI lets you configure the same harness knobs from the browser, launch the existing CLI as a child process, stream stdout/stderr, stop running jobs, and jump to the artifact directory shown in the run metadata.

It also includes:

- local game-runtime status/start/stop controls for the sibling Coordination Games repo
- a separate **Start runtime only** control and **Start runtime + run** control, because starting the runtime only starts the game server and does not create a lobby/game
- automatic detection of Wrangler's actual `Ready on ...` URL when the default `GAME_SERVER` port is already occupied
- inline multi-bot/persona editing
- generated per-run bot config files under ignored `runs/gui-configs/`
- clearer hints when `GAME_SERVER` is unreachable

Security boundaries:

- The GUI binds to `127.0.0.1` by default.
- API keys and inspector tokens are never stored in files, browser localStorage, or run metadata.
- Secrets entered in the form are passed only to the harness child process for that run, then the browser field is cleared.
- Run logs are redacted before being streamed to the browser.

Optional GUI env vars:

```bash
HARNESS_GUI_PORT=4317
HARNESS_GUI_HOST=127.0.0.1
HARNESS_GAME_RUNTIME_DIR="/Users/djimoserodio/Documents/Coordination game"
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
- `WEB_BASE_URL=http://localhost:5173`
- `GAME_TYPE=tragedy-of-the-commons`
- `INSPECTOR_TOKEN=local-inspector-token`
- `PROVIDER=scripted`

No secrets belong in this repo. Export keys in your shell or use an ignored local env loader.

## Current scope

This repository is intentionally still Tragedy-of-the-Commons-specific: the prompts and valid action schemas are tuned for `tragedy-of-the-commons`. The platform boundary is decoupled from the Coordination Games monorepo, but the target server must still implement the Coordination Games HTTP API.

Because this is the lab bench, prefer adding reproducibility and analysis features here before changing game-server rules or future participant APIs.
