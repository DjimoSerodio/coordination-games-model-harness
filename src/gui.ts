#!/usr/bin/env tsx
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';

const PORT = Number.parseInt(process.env.HARNESS_GUI_PORT ?? '4317', 10);
const HOST = process.env.HARNESS_GUI_HOST ?? '127.0.0.1';
const ROOT = process.cwd();
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

interface LogEntry {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: string;
}

interface RunRecord {
  id: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  artifactDir: string;
  child: ChildProcessByStdio<null, Readable, Readable> | null;
  config: Record<string, string | boolean>;
  logs: LogEntry[];
  clients: Set<ServerResponse>;
}

const runs = new Map<string, RunRecord>();

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s,}]+/gi, 'apiKey=[REDACTED]');
}

function sanitizeRunId(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
  return sanitized || `gui-${randomUUID()}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Not found' });
}

function appendLog(run: RunRecord, stream: LogEntry['stream'], text: string): void {
  const entry: LogEntry = { stream, text: redact(text), timestamp: new Date().toISOString() };
  run.logs.push(entry);
  if (run.logs.length > 1_000) run.logs.shift();
  broadcast(run, 'log', entry);
}

function broadcast(run: RunRecord, event: string, value: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of run.clients) client.write(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function assertSafeRelativePath(value: string, label: string): string {
  if (!value) return '';
  if (path.isAbsolute(value)) throw new Error(`${label} must be relative to the harness repo`);
  const normalized = path.normalize(value);
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error(`${label} cannot escape the harness repo`);
  }
  return normalized;
}

function envFromConfig(raw: Record<string, unknown>, runId: string): { env: NodeJS.ProcessEnv; publicConfig: Record<string, string | boolean> } {
  const provider = optionalString(raw, 'provider', 'scripted');
  if (!['scripted', 'openai-compatible', 'minimax'].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const botConfig = assertSafeRelativePath(optionalString(raw, 'botConfig', 'examples/tragedy-bots.example.json'), 'BOT_CONFIG');
  const resultsDir = assertSafeRelativePath(optionalString(raw, 'resultsDir', 'runs/model-harness'), 'HARNESS_RESULTS_DIR');
  const apiKey = optionalString(raw, 'apiKey');
  const inspectorToken = optionalString(raw, 'inspectorToken', 'local-inspector-token');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROVIDER: provider,
    GAME_SERVER: optionalString(raw, 'gameServer', 'http://127.0.0.1:8787'),
    WEB_BASE_URL: optionalString(raw, 'webBaseUrl', 'http://127.0.0.1:5173'),
    INSPECTOR_TOKEN: inspectorToken,
    GAME_TYPE: optionalString(raw, 'gameType', 'tragedy-of-the-commons'),
    BOT_COUNT: optionalString(raw, 'botCount', '4'),
    TEAM_SIZE: optionalString(raw, 'teamSize', '2'),
    HARNESS_ROUNDS: optionalString(raw, 'rounds', '12'),
    HARNESS_COMMUNICATION_SWEEPS: optionalString(raw, 'communicationSweeps', '1'),
    HARNESS_RUN_ID: runId,
    HARNESS_MODEL_TIMEOUT_MS: optionalString(raw, 'modelTimeoutMs', '90000'),
    HARNESS_MODEL_RETRIES: optionalString(raw, 'modelRetries', '1'),
    HARNESS_ARTIFACTS: optionalBoolean(raw, 'artifactsEnabled', true) ? '1' : '0',
    HARNESS_RESULTS_DIR: resultsDir,
    HARNESS_MAX_COST_USD: optionalString(raw, 'maxCostUsd', '0'),
    HARNESS_PROMPT_USD_PER_1M: optionalString(raw, 'promptUsdPer1M', '0'),
    HARNESS_COMPLETION_USD_PER_1M: optionalString(raw, 'completionUsdPer1M', '0'),
    BOT_CONFIG: botConfig,
    APPEND_ADDRESS_SUFFIX: optionalBoolean(raw, 'appendAddressSuffix', true) ? 'true' : 'false',
    OPENAI_BASE_URL: optionalString(raw, 'openAiBaseUrl', 'https://api.minimax.io/v1'),
    MODEL: optionalString(raw, 'model', 'MiniMax-M2.7-highspeed'),
  };

  if (apiKey) {
    if (provider === 'minimax') env.MINIMAX_API_KEY = apiKey;
    if (provider === 'openai-compatible') env.OPENAI_API_KEY = apiKey;
  }

  const publicConfig: Record<string, string | boolean> = {
    provider,
    gameServer: env.GAME_SERVER ?? '',
    webBaseUrl: env.WEB_BASE_URL ?? '',
    gameType: env.GAME_TYPE ?? '',
    botCount: env.BOT_COUNT ?? '',
    teamSize: env.TEAM_SIZE ?? '',
    rounds: env.HARNESS_ROUNDS ?? '',
    communicationSweeps: env.HARNESS_COMMUNICATION_SWEEPS ?? '',
    modelTimeoutMs: env.HARNESS_MODEL_TIMEOUT_MS ?? '',
    modelRetries: env.HARNESS_MODEL_RETRIES ?? '',
    artifactsEnabled: env.HARNESS_ARTIFACTS !== '0',
    resultsDir,
    maxCostUsd: env.HARNESS_MAX_COST_USD ?? '',
    promptUsdPer1M: env.HARNESS_PROMPT_USD_PER_1M ?? '',
    completionUsdPer1M: env.HARNESS_COMPLETION_USD_PER_1M ?? '',
    botConfig,
    appendAddressSuffix: env.APPEND_ADDRESS_SUFFIX !== 'false',
    openAiBaseUrl: env.OPENAI_BASE_URL ?? '',
    model: env.MODEL ?? '',
    apiKeyProvided: Boolean(apiKey),
    inspectorTokenProvided: Boolean(inspectorToken),
  };

  return { env, publicConfig };
}

async function botConfigOptions(): Promise<string[]> {
  try {
    const entries = await readdir(path.join(ROOT, 'examples'), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => `examples/${entry.name}`);
  } catch {
    return [];
  }
}

function publicRun(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    exitCode: run.exitCode,
    artifactDir: run.artifactDir,
    config: run.config,
    logs: run.logs,
  };
}

async function startRun(raw: unknown): Promise<RunRecord> {
  if (!isRecord(raw)) throw new Error('Run payload must be an object');
  const requestedId = optionalString(raw, 'runId', `gui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const runId = sanitizeRunId(requestedId);
  if (runs.has(runId)) throw new Error(`Run already exists: ${runId}`);
  const { env, publicConfig } = envFromConfig(raw, runId);
  const artifactDir = path.join(env.HARNESS_RESULTS_DIR ?? 'runs/model-harness', runId);
  const child = spawn(TSX_BIN, ['src/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run: RunRecord = {
    id: runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    artifactDir,
    child,
    config: publicConfig,
    logs: [],
    clients: new Set(),
  };
  runs.set(runId, run);
  appendLog(run, 'system', `Started harness run ${runId}`);
  child.stdout.on('data', (chunk) => appendLog(run, 'stdout', chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => appendLog(run, 'stderr', chunk.toString('utf8')));
  child.on('error', (error) => {
    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    appendLog(run, 'system', `Failed to start harness: ${error.message}`);
    broadcast(run, 'status', publicRun(run));
  });
  child.on('close', (code) => {
    run.exitCode = code;
    run.completedAt = new Date().toISOString();
    if (run.status === 'running') run.status = code === 0 ? 'completed' : 'failed';
    run.child = null;
    appendLog(run, 'system', `Harness exited with code ${code ?? 'unknown'}`);
    broadcast(run, 'status', publicRun(run));
  });
  return run;
}

async function stopRun(id: string): Promise<RunRecord> {
  const run = runs.get(id);
  if (!run) throw new Error(`Unknown run: ${id}`);
  if (run.child && run.status === 'running') {
    run.status = 'stopped';
    run.child.kill('SIGTERM');
    appendLog(run, 'system', 'Stop requested from GUI');
    broadcast(run, 'status', publicRun(run));
  }
  return run;
}

async function sendDefaults(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    botConfigs: await botConfigOptions(),
    defaults: {
      provider: 'scripted',
      gameServer: 'http://127.0.0.1:8787',
      webBaseUrl: 'http://127.0.0.1:5173',
      inspectorToken: 'local-inspector-token',
      gameType: 'tragedy-of-the-commons',
      botCount: '4',
      teamSize: '2',
      rounds: '12',
      communicationSweeps: '1',
      modelTimeoutMs: '90000',
      modelRetries: '1',
      artifactsEnabled: true,
      resultsDir: 'runs/model-harness',
      maxCostUsd: '0',
      promptUsdPer1M: '0',
      completionUsdPer1M: '0',
      botConfig: 'examples/tragedy-bots.example.json',
      appendAddressSuffix: true,
      openAiBaseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M2.7-highspeed',
    },
  });
}

function attachEvents(res: ServerResponse, run: RunRecord): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  run.clients.add(res);
  res.write(`event: status\ndata: ${JSON.stringify(publicRun(run))}\n\n`);
  for (const entry of run.logs) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  res.on('close', () => run.clients.delete(res));
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, htmlPage());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/defaults') {
      await sendDefaults(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      sendJson(res, 200, [...runs.values()].map(publicRun));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const run = await startRun(await readBody(req));
      sendJson(res, 201, publicRun(run));
      return;
    }
    const eventMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (req.method === 'GET' && eventMatch?.[1]) {
      const run = runs.get(eventMatch[1]);
      if (!run) sendNotFound(res);
      else attachEvents(res, run);
      return;
    }
    const stopMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stopMatch?.[1]) {
      sendJson(res, 200, publicRun(await stopRun(stopMatch[1])));
      return;
    }
    sendNotFound(res);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? redact(error.message) : redact(String(error)) });
  }
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Coordination Games Harness Console</title>
  <style>
    :root { color-scheme: dark; --ink: #f3eddc; --muted: #b9ad91; --paper: #15130f; --panel: #211d16; --line: #4a3f2e; --accent: #f3b85b; --green: #8bd38a; --red: #ff7b6e; --blue: #86b7ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--ink); background: radial-gradient(circle at 14% 8%, rgba(243, 184, 91, .16), transparent 30%), radial-gradient(circle at 88% 18%, rgba(134, 183, 255, .12), transparent 28%), linear-gradient(135deg, #0d0c0a 0%, #19150f 50%, #0f1111 100%); font-family: "Azeret Mono", "IBM Plex Mono", monospace; }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .12; background-image: linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px); background-size: 42px 42px; mask-image: radial-gradient(circle at center, black, transparent 78%); }
    main { width: min(1480px, calc(100vw - 40px)); margin: 0 auto; padding: 34px 0 40px; }
    header { display: grid; grid-template-columns: 1.2fr .8fr; gap: 24px; align-items: end; margin-bottom: 24px; }
    h1 { margin: 0; font-family: "Fraunces", Georgia, serif; font-size: clamp(42px, 7vw, 96px); line-height: .86; letter-spacing: -.06em; max-width: 840px; }
    .deck { color: var(--muted); max-width: 520px; line-height: 1.55; font-size: 14px; border-left: 1px solid var(--line); padding-left: 18px; }
    .grid { display: grid; grid-template-columns: minmax(360px, 480px) 1fr; gap: 22px; align-items: start; }
    section { background: color-mix(in srgb, var(--panel) 88%, black); border: 1px solid var(--line); box-shadow: 0 24px 80px rgba(0,0,0,.32); }
    form { padding: 18px; display: grid; gap: 16px; }
    .fieldset { border: 1px solid rgba(243, 184, 91, .18); padding: 14px; background: rgba(255,255,255,.025); }
    .fieldset h2 { margin: 0 0 12px; color: var(--accent); font-size: 12px; text-transform: uppercase; letter-spacing: .18em; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 0; background: #100e0a; color: var(--ink); padding: 10px 11px; font: inherit; font-size: 13px; outline: none; }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(243,184,91,.16); }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .check { display: flex; gap: 10px; align-items: center; text-transform: none; letter-spacing: 0; font-size: 13px; }
    .check input { width: auto; }
    button { border: 1px solid var(--accent); background: var(--accent); color: #151006; font-weight: 800; padding: 12px 14px; cursor: pointer; font: inherit; text-transform: uppercase; letter-spacing: .08em; }
    button.secondary { background: transparent; color: var(--accent); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .runs { min-height: 720px; display: grid; grid-template-rows: auto 1fr; }
    .runs-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; border-bottom: 1px solid var(--line); }
    .runs-head h2 { margin: 0; font-family: "Fraunces", Georgia, serif; font-size: 30px; letter-spacing: -.04em; }
    .status { font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: var(--muted); }
    .console { display: grid; grid-template-columns: 270px 1fr; min-height: 650px; }
    .run-list { border-right: 1px solid var(--line); padding: 12px; display: grid; gap: 10px; align-content: start; }
    .run-card { border: 1px solid var(--line); padding: 11px; background: rgba(255,255,255,.025); cursor: pointer; }
    .run-card.active { border-color: var(--accent); background: rgba(243,184,91,.08); }
    .pill { display: inline-flex; border: 1px solid currentColor; padding: 3px 7px; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
    .running { color: var(--blue); } .completed { color: var(--green); } .failed { color: var(--red); } .stopped { color: var(--muted); }
    .terminal-wrap { min-width: 0; display: grid; grid-template-rows: auto 1fr; }
    .meta { padding: 12px 14px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; display: grid; gap: 6px; }
    pre { margin: 0; padding: 16px; overflow: auto; background: #090806; color: #efe6cf; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
    .stdout { color: #efe6cf; } .stderr { color: #ff9b8f; } .system { color: #f3b85b; }
    .note { color: var(--muted); font-size: 12px; line-height: 1.45; }
    @media (max-width: 1000px) { header, .grid, .console { grid-template-columns: 1fr; } .run-list { border-right: 0; border-bottom: 1px solid var(--line); } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Harness Console</h1>
    <p class="deck">Local-only control room for Coordination Games research runs. Configure models, personas, budgets, and artifacts without making the harness a future participant requirement.</p>
  </header>
  <div class="grid">
    <section>
      <form id="run-form">
        <div class="fieldset"><h2>Run</h2>
          <label>Run ID <input name="runId" placeholder="gui-smoke-run" /></label>
          <div class="row"><label>Game server <input name="gameServer" /></label><label>Web URL <input name="webBaseUrl" /></label></div>
          <div class="row"><label>Game type <input name="gameType" /></label><label>Bot config <select name="botConfig"></select></label></div>
          <div class="row"><label>Rounds <input name="rounds" inputmode="numeric" /></label><label>Communication sweeps <input name="communicationSweeps" inputmode="numeric" /></label></div>
          <label class="check"><input type="checkbox" name="appendAddressSuffix" /> Append wallet suffix to bot names</label>
        </div>
        <div class="fieldset"><h2>Provider</h2>
          <div class="row"><label>Provider <select name="provider"><option value="scripted">scripted</option><option value="minimax">minimax</option><option value="openai-compatible">openai-compatible</option></select></label><label>Model <input name="model" /></label></div>
          <label>OpenAI-compatible base URL <input name="openAiBaseUrl" /></label>
          <label>API key <input name="apiKey" type="password" autocomplete="off" placeholder="not stored; passed only to child process" /></label>
          <label>Inspector token <input name="inspectorToken" type="password" autocomplete="off" /></label>
        </div>
        <div class="fieldset"><h2>Safety + artifacts</h2>
          <div class="row"><label>Timeout ms <input name="modelTimeoutMs" inputmode="numeric" /></label><label>Retries <input name="modelRetries" inputmode="numeric" /></label></div>
          <label>Results dir <input name="resultsDir" /></label>
          <div class="row"><label>Max cost USD <input name="maxCostUsd" /></label><label>Prompt $ / 1M <input name="promptUsdPer1M" /></label></div>
          <label>Completion $ / 1M <input name="completionUsdPer1M" /></label>
          <label class="check"><input type="checkbox" name="artifactsEnabled" /> Write artifacts</label>
        </div>
        <button id="start-button" type="submit">Start run</button>
        <p class="note">Secrets are never stored in GUI state or run metadata. They are passed to the harness subprocess only for the selected run.</p>
      </form>
    </section>
    <section class="runs">
      <div class="runs-head"><h2>Runs</h2><span id="server-status" class="status">ready</span></div>
      <div class="console"><div id="run-list" class="run-list"></div><div class="terminal-wrap"><div id="meta" class="meta">No run selected.</div><pre id="terminal"></pre></div></div>
    </section>
  </div>
</main>
<script>
const form = document.querySelector('#run-form');
const runList = document.querySelector('#run-list');
const terminal = document.querySelector('#terminal');
const meta = document.querySelector('#meta');
const serverStatus = document.querySelector('#server-status');
const startButton = document.querySelector('#start-button');
let runs = [];
let activeRunId = null;
let source = null;

function field(name) { return form.elements.namedItem(name); }
function setValue(name, value) { const el = field(name); if (!el) return; if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value ?? ''; }
function valueOf(name) { const el = field(name); if (!el) return ''; return el.type === 'checkbox' ? el.checked : el.value; }
function lineClass(stream) { return stream === 'stderr' ? 'stderr' : stream === 'system' ? 'system' : 'stdout'; }
function escapeHtml(text) { return String(text).replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }

function renderRuns() {
  runList.innerHTML = runs.map(run => '<div class="run-card ' + (run.id === activeRunId ? 'active' : '') + '" data-id="' + run.id + '"><span class="pill ' + run.status + '">' + run.status + '</span><div style="margin-top:8px">' + run.id + '</div><div class="note">' + run.config.provider + ' · ' + run.config.model + '</div></div>').join('');
}
function renderActive(run) {
  if (!run) { meta.textContent = 'No run selected.'; terminal.textContent = ''; return; }
  meta.innerHTML = '<strong>' + run.id + '</strong><span>Status: ' + run.status + ' · artifact dir: ' + run.artifactDir + '</span><span>Started: ' + run.startedAt + '</span>' + (run.status === 'running' ? '<button class="secondary" id="stop-run" type="button">Stop run</button>' : '');
  terminal.innerHTML = (run.logs || []).map(entry => '<span class="' + lineClass(entry.stream) + '">[' + entry.stream + '] ' + escapeHtml(entry.text) + '</span>').join('');
  terminal.scrollTop = terminal.scrollHeight;
  const stop = document.querySelector('#stop-run');
  if (stop) stop.addEventListener('click', () => fetch('/api/runs/' + run.id + '/stop', { method: 'POST' }));
}
async function loadRuns() {
  runs = await fetch('/api/runs').then(res => res.json());
  renderRuns();
  renderActive(runs.find(run => run.id === activeRunId));
}
function attachEvents(runId) {
  if (source) source.close();
  source = new EventSource('/api/runs/' + runId + '/events');
  source.addEventListener('status', event => {
    const run = JSON.parse(event.data);
    const idx = runs.findIndex(item => item.id === run.id);
    if (idx >= 0) runs[idx] = run; else runs.unshift(run);
    renderRuns(); renderActive(run);
  });
  source.addEventListener('log', event => {
    const entry = JSON.parse(event.data);
    const run = runs.find(item => item.id === runId);
    if (!run) return;
    run.logs = run.logs || [];
    run.logs.push(entry);
    renderActive(run);
  });
}
runList.addEventListener('click', event => {
  const card = event.target.closest('.run-card');
  if (!card) return;
  activeRunId = card.dataset.id;
  attachEvents(activeRunId);
  renderRuns(); renderActive(runs.find(run => run.id === activeRunId));
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  startButton.disabled = true;
  serverStatus.textContent = 'starting';
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.appendAddressSuffix = valueOf('appendAddressSuffix');
  payload.artifactsEnabled = valueOf('artifactsEnabled');
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const run = await response.json();
    if (!response.ok) throw new Error(run.error || 'Run failed to start');
    runs.unshift(run); activeRunId = run.id; attachEvents(run.id); renderRuns(); renderActive(run); serverStatus.textContent = 'running';
  } catch (error) { serverStatus.textContent = error.message; }
  finally { startButton.disabled = false; field('apiKey').value = ''; }
});
fetch('/api/defaults').then(res => res.json()).then(data => {
  for (const [key, value] of Object.entries(data.defaults)) setValue(key, value);
  const select = field('botConfig');
  select.innerHTML = data.botConfigs.map(value => '<option value="' + value + '">' + value + '</option>').join('');
  setValue('botConfig', data.defaults.botConfig);
  return loadRuns();
});
</script>
</body>
</html>`;
}

createServer((req, res) => {
  void route(req, res);
}).listen(PORT, HOST, () => {
  console.log(`Harness GUI listening at http://${HOST}:${PORT}`);
});
