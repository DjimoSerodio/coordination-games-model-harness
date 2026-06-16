# Coordination Games model harness

Standalone local E2E harness for running scripted or OpenAI-compatible model agents against a local Coordination Games server.

The harness creates ephemeral wallet-backed bots, starts a lobby, joins the bots, polls player state, asks a provider for chat/DM/action decisions, publishes reasoning and chat relay messages, submits legal actions, and writes run artifacts plus final spectator/inspector links and message counts.

This repository is the internal lab bench for hardening Coordination Games and running repeatable model/persona/trust-plugin experiments. It should not become the mandatory future interface for outside teams or bring-your-own-agent participants.

## Requirements

- Node.js 20+
- A local Coordination Games server exposing the player/lobby/tool/admin inspect APIs
- For MiniMax/OpenAI-compatible runs, an API key exported in your shell
- For OpenCode Go runs, a local OpenCode server (`opencode serve --port 4096 --hostname 127.0.0.1`) with your OpenCode Go subscription configured

The server, not this harness, owns trust evidence publishing. If you want Lighthouse/IPFS records, start the Worker with its trust publishing env configured there.

This repo intentionally stays small: it is a local simulation client for Lucian's Coordination Games branch, not a fork of the whole game/server stack.

## Install

```bash
npm install
```

## Scripted smoke run

The scripted provider is only a harness plumbing smoke: it can submit runtime-advertised tools that require no arguments. For games or phases that require strategic arguments, configure model providers for the acting bots.

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

## OpenCode Go run

Use this to compare MiniMax API models against OpenCode Go subscription models. OpenCode Go runs use the local OpenCode server API, not a hosted OpenAI-compatible `/v1/chat/completions` endpoint. The harness defaults to OpenCode's `plan` agent for lower-latency game decisions; override `OPENCODE_GO_AGENT` only if you need another local agent. Start OpenCode locally first:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

The OpenCode Go subscription key must be configured for OpenCode itself, for example in `~/.config/opencode/opencode-go-api-key`. If your local OpenCode server is protected with Basic auth, start the harness/GUI with `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` available; otherwise no harness-side OpenCode Go API key is sent to the local server.

Available OpenCode Go model IDs from the local OpenCode CLI include:

- `opencode-go/minimax-m3`
- `opencode-go/minimax-m2.7`
- `opencode-go/kimi-k2.7-code`
- `opencode-go/kimi-k2.6`
- `opencode-go/glm-5.1`
- `opencode-go/glm-5`
- `opencode-go/qwen3.7-max`
- `opencode-go/qwen3.7-plus`
- `opencode-go/qwen3.6-plus`
- `opencode-go/deepseek-v4-pro`
- `opencode-go/deepseek-v4-flash`
- `opencode-go/mimo-v2.5-pro`
- `opencode-go/mimo-v2.5`

```bash
PROVIDER=opencode-go \
OPENCODE_GO_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_GO_AGENT=plan \
OPENCODE_SERVER_USERNAME=opencode \
MODEL=opencode-go/minimax-m3 \
GAME_SERVER=http://127.0.0.1:8787 \
BOT_CONFIG=examples/tragedy-bots.example.json \
HARNESS_ROUNDS=12 \
HARNESS_COMMUNICATION_SWEEPS=1 \
npm run harness:model
```

## Run artifacts and research controls

Each run writes non-secret artifacts under `runs/model-harness/<run-id>/` unless `HARNESS_ARTIFACTS=0` is set:

- `run.config.json` - resolved non-secret run configuration.
- `games.jsonl` - lobby/game lifecycle events.
- `turns.jsonl` - model decisions, submitted actions, and correction attempts.
- `errors.jsonl` - provider/action errors with redacted sensitive text.
- `summary.json` - final run summary and spectator/inspector URLs.
- `costs.json` - observed token usage plus optional estimated USD cost.

Useful knobs:

```bash
HARNESS_RUN_ID=my-local-run          # optional; sanitized before use
HARNESS_MODEL_TIMEOUT_MS=90000      # per model call
HARNESS_MODEL_RETRIES=1             # retry provider failures/timeouts
HARNESS_GAME_API_TIMEOUT_MS=10000   # per game-server call timeout
HARNESS_GAME_API_RETRIES=2          # retry transient safe/idempotent game-server failures/timeouts
HARNESS_GAME_API_RETRY_BASE_DELAY_MS=250  # exponential backoff base in ms
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
- API keys are never written to generated bot configs, run metadata, artifacts, logs, or browser localStorage.
- If you click **Save key locally**, provider keys are stored only on this machine in `~/.config/coordination-games-model-harness/secrets.json` with owner-only file permissions. OpenCode Go also detects `~/.config/opencode/opencode-go-api-key` when present, but model calls still go through the local OpenCode server and use `OPENCODE_SERVER_PASSWORD` only when that server requires Basic auth.
- Secrets entered in the form are passed only to the harness child process for that run, then the browser field is cleared. Inspector tokens are not saved by the GUI.
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
- optional provider overrides: `provider`, `model`, `baseUrl`, `apiKeyEnv`, `temperature`, `topP`, `maxCompletionTokens`, `reasoningSplit`, `reasoningEffort`

Provider overrides are per bot. Omitted or blank fields inherit the run-level provider settings. `apiKeyEnv` names an environment variable already available to the harness process; API key values do not belong in bot config files. For safety, `OPENAI_API_KEY` is limited to `api.openai.com`, `MINIMAX_API_KEY` is limited to `api.minimax.io`, `OPENCODE_GO_API_KEY` is limited to `api.opencode.ai` or a loopback OpenCode server, and custom provider base URLs require a harness-scoped `HARNESS_*_API_KEY` variable. Provider base URLs must use HTTPS, except loopback HTTP is allowed for local test servers.

By default the harness appends a wallet suffix to each bot name to avoid local name collisions. Set `APPEND_ADDRESS_SUFFIX=false` if you need exact fixed names.

## Environment

See `.env.example` for the full set of options. Important defaults:

- `GAME_SERVER=http://127.0.0.1:8787`
- `WEB_BASE_URL=http://localhost:5173`
- `GAME_TYPE=tragedy-of-the-commons`
- `INSPECTOR_TOKEN=local-inspector-token`
- `PROVIDER=scripted`
- `MODEL_TEMPERATURE=1`
- `MODEL_TOP_P=0.95`
- `MODEL_MAX_COMPLETION_TOKENS=1024`
- `MODEL_REASONING_SPLIT=true`

No secrets belong in this repo. Export keys in your shell or use an ignored local env loader.

## Current scope

The harness is game-agnostic at the action boundary: it reads live `currentPhase.tools` from `/api/player/state`, prompts model providers with those runtime-advertised tool schemas, submits only advertised tool names, and feeds runtime validation errors back to the model once for correction. The target server must implement the Coordination Games HTTP API.

Because this is the lab bench, prefer adding reproducibility and analysis features here before changing game-server rules or future participant APIs.
