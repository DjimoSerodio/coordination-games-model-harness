#!/usr/bin/env tsx
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

const PORT = Number.parseInt(process.env.HARNESS_GUI_PORT ?? '4317', 10);
const HOST = process.env.HARNESS_GUI_HOST ?? '127.0.0.1';
const ROOT = process.cwd();
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const DEFAULT_RUNTIME_DIR = path.resolve(process.env.HARNESS_GAME_RUNTIME_DIR ?? path.resolve(ROOT, '..', 'Coordination game'));
const LOCAL_SECRET_DIR = path.join(homedir(), '.config', 'coordination-games-model-harness');
const LOCAL_SECRET_FILE = path.join(LOCAL_SECRET_DIR, 'secrets.json');
const OPENCODE_GO_KEY_FILE = path.join(homedir(), '.config', 'opencode', 'opencode-go-api-key');
const LOCAL_CONFIG_FILE = path.join(LOCAL_SECRET_DIR, 'console-config.json');
const ALLOWED_PROVIDERS = new Set(['scripted', 'minimax', 'openai-compatible', 'opencode-go']);
const MINIMAX_MODEL_EXAMPLES = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'];
const OPENCODE_GO_MODEL_EXAMPLES = ['opencode-go/minimax-m3', 'opencode-go/minimax-m2.7', 'opencode-go/kimi-k2.7-code', 'opencode-go/kimi-k2.6', 'opencode-go/glm-5.1', 'opencode-go/glm-5', 'opencode-go/qwen3.7-max', 'opencode-go/qwen3.7-plus', 'opencode-go/qwen3.6-plus', 'opencode-go/deepseek-v4-pro', 'opencode-go/deepseek-v4-flash', 'opencode-go/mimo-v2.5-pro', 'opencode-go/mimo-v2.5'];
const OPENAI_COMPATIBLE_MODEL_EXAMPLES = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];

type SecretProvider = 'minimax' | 'opencode-go' | 'openai-compatible';
const SECRET_ENV_BY_PROVIDER: Record<SecretProvider, string> = {
  minimax: 'MINIMAX_API_KEY',
  'opencode-go': 'OPENCODE_GO_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

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

interface BotEditorConfig {
  name: string;
  id: string;
  title: string;
  instruction: string;
  publicStyle: string;
  privateStyle: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  temperature: string;
  topP: string;
  maxCompletionTokens: string;
  reasoningSplit: string;
  reasoningEffort: string;
}

interface RuntimeRecord {
  status: 'stopped' | 'starting' | 'running' | 'failed';
  runtimeDir: string;
  command: string;
  startedAt: string | null;
  exitCode: number | null;
  detectedServerUrl: string | null;
  child: ChildProcessByStdio<null, Readable, Readable> | null;
  logs: LogEntry[];
}

const runs = new Map<string, RunRecord>();
let runtime: RuntimeRecord = {
  status: 'stopped',
  runtimeDir: DEFAULT_RUNTIME_DIR,
  command: 'npm run dev',
  startedAt: null,
  exitCode: null,
  detectedServerUrl: null,
  child: null,
  logs: [],
};

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s,}]+/gi, 'apiKey=[REDACTED]');
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '[REDACTED]' : '';
      parsed.password = parsed.password ? '[REDACTED]' : '';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|password|credential|auth/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' && !parsed.search ? '' : '/');
  } catch {
    return value;
  }
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
  const hint = text.includes('TypeError: fetch failed')
    ? `${text}\n[harness gui hint] The harness could not reach GAME_SERVER. Use “Check runtime” or “Start runtime”, then retry the run.\n`
    : text;
  const entry: LogEntry = { stream, text: redact(hint), timestamp: new Date().toISOString() };
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

function optionalScalarString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

function optionalBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function secretProvider(value: string): SecretProvider {
  if (value === 'minimax' || value === 'opencode-go' || value === 'openai-compatible') return value;
  throw new Error('Choose minimax, opencode-go, or openai-compatible before saving an API key');
}

interface BotSecretEntry {
  key: string;
  provider?: string | undefined;
  model?: string | undefined;
}

interface LocalSecretsFile {
  providers: Partial<Record<SecretProvider, string>>;
  bots: Record<string, BotSecretEntry>;
}

async function readSecretsFile(): Promise<LocalSecretsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(LOCAL_SECRET_FILE, 'utf8'));
    if (!isRecord(parsed)) return { providers: {}, bots: {} };
    const providers: Partial<Record<SecretProvider, string>> = {};
    for (const provider of Object.keys(SECRET_ENV_BY_PROVIDER) as SecretProvider[]) {
      const value = parsed[provider];
      if (typeof value === 'string' && value.trim()) providers[provider] = value.trim();
    }
    const bots: Record<string, BotSecretEntry> = {};
    if (isRecord(parsed.bots)) {
      for (const [botId, value] of Object.entries(parsed.bots)) {
        if (typeof value === 'string' && value.trim()) {
          bots[botId] = { key: value.trim() };
        } else if (isRecord(value) && typeof value.key === 'string' && value.key.trim()) {
          bots[botId] = {
            key: value.key.trim(),
            provider: typeof value.provider === 'string' && value.provider.trim() ? value.provider.trim() : undefined,
            model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : undefined,
          };
        }
      }
    }
    return { providers, bots };
  } catch {
    return { providers: {}, bots: {} };
  }
}

async function readLocalSecrets(): Promise<Partial<Record<SecretProvider, string>>> {
  return (await readSecretsFile()).providers;
}

async function readLocalBotSecrets(): Promise<Record<string, string>> {
  return botKeyMap((await readSecretsFile()).bots);
}

function botKeyMap(bots: Record<string, BotSecretEntry>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [botId, entry] of Object.entries(bots)) out[botId] = entry.key;
  return out;
}

function botMetaMap(bots: Record<string, BotSecretEntry>): Record<string, { provider: string; model: string }> {
  const out: Record<string, { provider: string; model: string }> = {};
  for (const [botId, entry] of Object.entries(bots)) out[botId] = { provider: entry.provider ?? '', model: entry.model ?? '' };
  return out;
}

interface ConsoleConfig {
  defaults: Record<string, string | boolean>;
  bots: BotEditorConfig[];
}

function sanitizeConfigDefaults(raw: Record<string, unknown>): Record<string, string | boolean> {
  const defaults: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'apiKey' || key === 'inspectorToken') continue;
    if (typeof value === 'string' || typeof value === 'boolean') defaults[key] = value;
  }
  return defaults;
}

async function readLocalConfig(): Promise<ConsoleConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(LOCAL_CONFIG_FILE, 'utf8'));
    if (!isRecord(parsed)) return null;
    const defaults = sanitizeConfigDefaults(isRecord(parsed.defaults) ? parsed.defaults : {});
    const bots = parseBots(parsed.bots) ?? [];
    return { defaults, bots };
  } catch {
    return null;
  }
}

async function writeLocalConfig(config: ConsoleConfig): Promise<void> {
  await mkdir(LOCAL_SECRET_DIR, { recursive: true, mode: 0o700 });
  const safeDefaults = sanitizeConfigDefaults(config.defaults);
  const safeBots = config.bots.map((bot) => ({ ...bot, apiKey: '' }));
  await writeFile(LOCAL_CONFIG_FILE, `${JSON.stringify({ defaults: safeDefaults, bots: safeBots }, null, 2)}\n`, { mode: 0o600 });
  await chmod(LOCAL_CONFIG_FILE, 0o600);
}

async function readOpenCodeGoKeyFile(): Promise<string | undefined> {
  try {
    const value = (await readFile(OPENCODE_GO_KEY_FILE, 'utf8')).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeSecretsFile(file: LocalSecretsFile): Promise<void> {
  await mkdir(LOCAL_SECRET_DIR, { recursive: true, mode: 0o700 });
  const payload: Record<string, unknown> = { ...file.providers };
  if (Object.keys(file.bots).length > 0) payload.bots = file.bots;
  await writeFile(LOCAL_SECRET_FILE, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(LOCAL_SECRET_FILE, 0o600);
}

async function writeLocalSecrets(secrets: Partial<Record<SecretProvider, string>>): Promise<void> {
  const file = await readSecretsFile();
  await writeSecretsFile({ providers: secrets, bots: file.bots });
}

async function saveLocalBotSecrets(botEntries: Record<string, BotSecretEntry>): Promise<void> {
  const trimmed: Record<string, BotSecretEntry> = {};
  for (const [botId, entry] of Object.entries(botEntries)) {
    if (botId.trim() && entry.key.trim()) {
      trimmed[botId.trim()] = {
        key: entry.key.trim(),
        provider: entry.provider?.trim() || undefined,
        model: entry.model?.trim() || undefined,
      };
    }
  }
  if (Object.keys(trimmed).length === 0) return;
  const file = await readSecretsFile();
  await writeSecretsFile({ providers: file.providers, bots: { ...file.bots, ...trimmed } });
}

async function saveLocalSecret(provider: SecretProvider, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('API key is required to save locally');
  await writeLocalSecrets({ ...(await readLocalSecrets()), [provider]: trimmed });
}

async function deleteLocalSecret(provider: SecretProvider): Promise<void> {
  const secrets = await readLocalSecrets();
  delete secrets[provider];
  await writeLocalSecrets(secrets);
}

async function localSecretStatus(secrets: Partial<Record<SecretProvider, string>>): Promise<Record<SecretProvider, boolean>> {
  return {
    minimax: Boolean(secrets.minimax),
    'opencode-go': Boolean(secrets['opencode-go'] || (await readOpenCodeGoKeyFile())),
    'openai-compatible': Boolean(secrets['openai-compatible']),
  };
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

function assertSafeRuntimeDir(value: string): string {
  const runtimeDir = value.trim() ? path.resolve(value.trim()) : DEFAULT_RUNTIME_DIR;
  return runtimeDir;
}

function hasSensitiveQuery(parsed: URL): boolean {
  return [...parsed.searchParams.keys()].some((key) => /token|key|secret|password|credential|auth/i.test(key));
}

function safeLoopbackHttpUrl(value: string): { url: string | null; error: string | null } {
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return { url: null, error: 'Only http(s) game server URLs are allowed for GUI health checks' };
    if (parsed.username || parsed.password) return { url: null, error: 'Game server URLs with credentials are not allowed' };
    if (hasSensitiveQuery(parsed)) return { url: null, error: 'Game server URLs with sensitive query parameters are not allowed' };
    if (!isLoopbackHost(parsed.hostname)) return { url: null, error: `GUI health checks are limited to loopback hosts, got ${parsed.hostname}` };
    parsed.hash = '';
    return { url: parsed.toString().replace(/\/$/, ''), error: null };
  } catch {
    return { url: null, error: `Invalid game server URL: ${value}` };
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseBots(raw: unknown): BotEditorConfig[] | null {
  if (!Array.isArray(raw)) return null;
  const bots = raw.filter(isRecord).map((bot, index): BotEditorConfig => ({
    name: optionalString(bot, 'name', `Harness Bot ${index + 1}`),
    id: optionalString(bot, 'id', `bot-${index + 1}`),
    title: optionalString(bot, 'title', `Harness Bot ${index + 1}`),
    instruction: optionalString(bot, 'instruction', 'Play the game according to your persona.'),
    publicStyle: optionalString(bot, 'publicStyle', 'I am ready to coordinate.'),
    privateStyle: optionalString(bot, 'privateStyle', 'I am looking for reliable partners.'),
    provider: optionalString(bot, 'provider'),
    model: optionalString(bot, 'model'),
    baseUrl: optionalString(bot, 'baseUrl', optionalString(bot, 'openAiBaseUrl')),
    apiKeyEnv: optionalString(bot, 'apiKeyEnv'),
    apiKey: optionalString(bot, 'apiKey'),
    temperature: optionalScalarString(bot, 'temperature'),
    topP: optionalScalarString(bot, 'topP'),
    maxCompletionTokens: optionalScalarString(bot, 'maxCompletionTokens'),
    reasoningSplit: optionalScalarString(bot, 'reasoningSplit'),
    reasoningEffort: optionalString(bot, 'reasoningEffort'),
  }));
  return bots.length > 0 ? bots : null;
}

function botConfigForFile(bot: BotEditorConfig, index: number): Record<string, string> {
  const { apiKey, ...safeBot } = bot;
  const rawKey = apiKey.trim();
  if (!rawKey) return safeBot;
  return { ...safeBot, apiKeyEnv: `HARNESS_BOT_${index + 1}_API_KEY` };
}

function envForBotApiKeys(bots: BotEditorConfig[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  bots.forEach((bot, index) => {
    const rawKey = bot.apiKey.trim();
    if (rawKey) env[`HARNESS_BOT_${index + 1}_API_KEY`] = rawKey;
  });
  return env;
}

async function hydrateAndPersistBotKeys(bots: BotEditorConfig[]): Promise<void> {
  const saved = await readLocalBotSecrets();
  const toPersist: Record<string, BotSecretEntry> = {};
  for (const bot of bots) {
    const botId = bot.id.trim();
    const rawKey = bot.apiKey.trim();
    if (rawKey) {
      if (botId) toPersist[botId] = { key: rawKey, provider: bot.provider?.trim() || undefined, model: bot.model?.trim() || undefined };
    } else if (botId && saved[botId]) {
      bot.apiKey = saved[botId];
    }
  }
  await saveLocalBotSecrets(toPersist);
}

async function persistGlobalKeyFromRun(raw: Record<string, unknown>): Promise<void> {
  const provider = optionalString(raw, 'provider', 'scripted');
  const apiKey = optionalString(raw, 'apiKey');
  if (!apiKey || provider === 'scripted' || !ALLOWED_PROVIDERS.has(provider)) return;
  await saveLocalSecret(secretProvider(provider), apiKey);
}

function defaultBaseUrlForProvider(provider: string): string {
  if (provider === 'opencode-go') return 'http://127.0.0.1:4096';
  return 'https://api.minimax.io/v1';
}

function validateMiniMaxModel(model: string, label: string): void {
  if (!model) return;
  if (/^m\d+(?:\b|[-_.])/i.test(model)) {
    throw new Error(`${label} uses MiniMax model "${model}", but MiniMax expects exact model IDs, not shorthand. Try ${MINIMAX_MODEL_EXAMPLES.join(' or ')}.`);
  }
  if (model.startsWith('opencode-go/')) {
    throw new Error(`${label} is configured as MiniMax but has OpenCode Go model "${model}". Choose provider opencode-go or pick a MiniMax model such as MiniMax-M2.7-highspeed.`);
  }
}

function defaultModelForProvider(provider: string, globalProvider: string, globalModel: string): string {
  if (provider === globalProvider) return globalModel;
  if (provider === 'minimax') return 'MiniMax-M2.7-highspeed';
  if (provider === 'opencode-go') return 'opencode-go/minimax-m3';
  if (provider === 'openai-compatible') return 'gpt-4.1';
  return globalModel;
}

function validateRunRounds(raw: Record<string, unknown>, bots: BotEditorConfig[]): void {
  if (optionalBoolean(raw, 'allowZeroRounds', false)) return;
  if (!runUsesModelProvider(raw, bots)) return;
  const rounds = Number.parseInt(optionalString(raw, 'rounds', '12'), 10);
  if (!Number.isFinite(rounds) || rounds < 1) {
    throw new Error('Rounds is set to 0, so the harness will only create a lobby/game and make zero model calls. Set Rounds to at least 1 for an actual model test.');
  }
}

function validateBotProviderSecrets(raw: Record<string, unknown>, bots: BotEditorConfig[]): void {
  const globalProvider = optionalString(raw, 'provider', 'scripted');
  if (!ALLOWED_PROVIDERS.has(globalProvider)) throw new Error(`Unknown provider: ${globalProvider}`);
  const globalModel = optionalString(raw, 'model', 'MiniMax-M2.7-highspeed');
  if (globalProvider === 'minimax') validateMiniMaxModel(globalModel, 'Global provider');
  if (optionalString(raw, 'apiKey') && globalProvider === 'scripted') {
    throw new Error('Global API key was provided, but the global provider is scripted. Choose minimax, opencode-go, or openai-compatible, or remove the global API key.');
  }
  const scriptedBots: string[] = [];
  bots.forEach((bot, index) => {
    if (bot.provider && !ALLOWED_PROVIDERS.has(bot.provider)) throw new Error(`Bot ${index + 1} (${bot.name}) has unknown provider: ${bot.provider}`);
    const effectiveProvider = bot.provider || globalProvider;
    const effectiveModel = bot.model || defaultModelForProvider(effectiveProvider, globalProvider, globalModel);
    if (effectiveProvider === 'minimax') validateMiniMaxModel(effectiveModel, `Bot ${index + 1} (${bot.name})`);
    if (effectiveProvider === 'scripted') scriptedBots.push(`Bot ${index + 1} (${bot.name})`);
    const hasBotSecret = Boolean(bot.apiKey.trim() || bot.apiKeyEnv.trim());
    if (hasBotSecret && effectiveProvider === 'scripted') {
      throw new Error(`Bot ${index + 1} (${bot.name}) has an API key, but its provider is scripted. Choose minimax, opencode-go, or openai-compatible for that bot.`);
    }
  });
  if (scriptedBots.length > 0) {
    throw new Error(`This GUI run still has scripted bots: ${scriptedBots.join(', ')}. Scripted is only a plumbing smoke and cannot follow runtime tools that require arguments. Set the global provider/API key so all bots inherit a model provider, or set provider/model/API key on every bot.`);
  }
  validateRunRounds(raw, bots);
}

function runUsesOpenCodeGo(raw: Record<string, unknown>, bots: BotEditorConfig[]): boolean {
  const globalProvider = optionalString(raw, 'provider', 'scripted');
  return globalProvider === 'opencode-go' || bots.some((bot) => (bot.provider || globalProvider) === 'opencode-go');
}

function runUsesModelProvider(raw: Record<string, unknown>, bots: BotEditorConfig[]): boolean {
  const globalProvider = optionalString(raw, 'provider', 'scripted');
  return globalProvider !== 'scripted' || bots.some((bot) => (bot.provider || globalProvider) !== 'scripted');
}

function openCodeAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    const username = env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return headers;
}

async function assertOpenCodeServerReady(env: NodeJS.ProcessEnv): Promise<void> {
  const baseUrl = (env.OPENCODE_GO_BASE_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid OPENCODE_GO_BASE_URL for OpenCode Go: ${baseUrl}`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(`OpenCode Go GUI runs are limited to a loopback opencode serve URL, got ${parsed.hostname}`);
  }
  const response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { ...openCodeAuthHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Coordination Games Harness GUI preflight ${Date.now()}` }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401) {
    throw new Error('OpenCode Go local server rejected GUI auth (HTTP 401). Restart the harness console with OPENCODE_SERVER_USERNAME=opencode and OPENCODE_SERVER_PASSWORD set to the password for `opencode serve`, then retry. The OpenCode Go API key field is not the same as local server Basic auth.');
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenCode Go local server preflight failed: HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  await response.arrayBuffer();
}

async function writeGeneratedBotConfig(runId: string, bots: BotEditorConfig[]): Promise<string> {
  const dir = path.join(ROOT, 'runs', 'gui-configs');
  await mkdir(dir, { recursive: true });
  const relativePath = path.join('runs', 'gui-configs', `${runId}.bots.json`);
  await writeFile(path.join(ROOT, relativePath), `${JSON.stringify({ bots: bots.map(botConfigForFile) }, null, 2)}\n`);
  return relativePath;
}

async function loadDefaultBots(): Promise<BotEditorConfig[]> {
  const examplePath = path.join(ROOT, 'examples', 'tragedy-bots.example.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(examplePath, 'utf8'));
    const rawBots = isRecord(parsed) && Array.isArray(parsed.bots) ? parsed.bots : Array.isArray(parsed) ? parsed : [];
    return parseBots(rawBots) ?? [];
  } catch {
    return [];
  }
}

function appendRuntimeLog(stream: LogEntry['stream'], text: string): void {
  const readyMatch = text.match(/Ready on\s+(https?:\/\/[^\s]+)/i);
  if (readyMatch?.[1]) runtime.detectedServerUrl = readyMatch[1].replace(/\/$/, '');
  runtime.logs.push({ stream, text: redact(text), timestamp: new Date().toISOString() });
  if (runtime.logs.length > 300) runtime.logs.shift();
}

async function runtimeStatus(gameServer: string): Promise<Record<string, unknown>> {
  const requested = safeLoopbackHttpUrl(gameServer);
  const detected = runtime.detectedServerUrl ? safeLoopbackHttpUrl(runtime.detectedServerUrl) : { url: null, error: null };
  const requestedGameServer = requested.url ?? redactUrl(gameServer.replace(/\/$/, ''));
  const candidateServers = [...new Set([detected.url, requested.url].filter((value): value is string => Boolean(value)))];
  let serverReachable = false;
  let serverError = requested.error ?? detected.error ?? '';
  let effectiveGameServer = requestedGameServer;
  for (const candidate of candidateServers) {
    try {
      const response = await fetch(candidate, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
      if (response.status < 500) {
        serverReachable = true;
        effectiveGameServer = candidate;
        serverError = '';
        break;
      }
      serverError = `${redactUrl(candidate)} returned ${response.status}`;
    } catch (error) {
      serverError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    status: runtime.status,
    runtimeDir: runtime.runtimeDir,
    command: runtime.command,
    startedAt: runtime.startedAt,
    exitCode: runtime.exitCode,
    requestedGameServer,
    detectedServerUrl: detected.url,
    effectiveGameServer,
    serverReachable,
    serverError,
    logs: runtime.logs,
  };
}

async function startRuntime(raw: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(raw)) throw new Error('Runtime payload must be an object');
  if (runtime.child && runtime.status !== 'stopped' && runtime.status !== 'failed') return runtimeStatus(optionalString(raw, 'gameServer', 'http://127.0.0.1:8787'));
  const runtimeDir = assertSafeRuntimeDir(optionalString(raw, 'runtimeDir', DEFAULT_RUNTIME_DIR));
  await access(runtimeDir);
  const command = optionalString(raw, 'runtimeCommand', 'npm run dev');
  const commandMap: Record<string, { bin: string; args: string[]; label: string }> = {
    'npm run dev': { bin: 'npm', args: ['run', 'dev'], label: 'npm run dev' },
    'npm run dev --workspace=packages/workers-server': {
      bin: 'npm',
      args: ['run', 'dev', '--workspace=packages/workers-server'],
      label: 'npm run dev --workspace=packages/workers-server',
    },
  };
  const selected = commandMap[command] ?? commandMap['npm run dev'];
  if (!selected) throw new Error(`Unsupported runtime command: ${command}`);
  const child = spawn(selected.bin, selected.args, { cwd: runtimeDir, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime = {
    status: 'starting',
    runtimeDir,
    command: selected.label,
    startedAt: new Date().toISOString(),
    exitCode: null,
    detectedServerUrl: null,
    child,
    logs: [],
  };
  appendRuntimeLog('system', `Starting game runtime in ${runtimeDir}: ${selected.label}`);
  child.stdout.on('data', (chunk) => appendRuntimeLog('stdout', chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => appendRuntimeLog('stderr', chunk.toString('utf8')));
  child.on('error', (error) => {
    runtime.status = 'failed';
    appendRuntimeLog('system', `Runtime failed: ${error.message}`);
  });
  child.on('close', (code) => {
    runtime.status = code === 0 ? 'stopped' : 'failed';
    runtime.exitCode = code;
    runtime.child = null;
    appendRuntimeLog('system', `Runtime exited with code ${code ?? 'unknown'}`);
  });
  setTimeout(() => {
    if (runtime.child && runtime.status === 'starting') runtime.status = 'running';
  }, 1000);
  return runtimeStatus(optionalString(raw, 'gameServer', 'http://127.0.0.1:8787'));
}

function stopRuntime(): Record<string, unknown> {
  if (runtime.child) {
    runtime.child.kill('SIGTERM');
    runtime.status = 'stopped';
    runtime.child = null;
    appendRuntimeLog('system', 'Stop requested from GUI');
  }
  return {
    status: runtime.status,
    runtimeDir: runtime.runtimeDir,
    command: runtime.command,
    startedAt: runtime.startedAt,
    exitCode: runtime.exitCode,
    detectedServerUrl: runtime.detectedServerUrl,
    logs: runtime.logs,
  };
}

async function envFromConfig(raw: Record<string, unknown>, runId: string): Promise<{ env: NodeJS.ProcessEnv; publicConfig: Record<string, string | boolean> }> {
  const provider = optionalString(raw, 'provider', 'scripted');
  if (!['scripted', 'openai-compatible', 'minimax', 'opencode-go'].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const botConfig = assertSafeRelativePath(optionalString(raw, 'botConfig', 'examples/tragedy-bots.example.json'), 'BOT_CONFIG');
  const resultsDir = assertSafeRelativePath(optionalString(raw, 'resultsDir', 'runs/model-harness'), 'HARNESS_RESULTS_DIR');
  const apiKey = optionalString(raw, 'apiKey');
  const inspectorToken = optionalString(raw, 'inspectorToken', 'local-inspector-token');
  const savedSecrets = await readLocalSecrets();
  const opencodeGoKeyFile = await readOpenCodeGoKeyFile();
  const submittedBaseUrl = optionalString(raw, 'openAiBaseUrl');
  const effectiveBaseUrl =
    provider === 'opencode-go' &&
    (!submittedBaseUrl || submittedBaseUrl === 'https://api.minimax.io/v1' || submittedBaseUrl === 'https://api.opencode.ai/v1')
      ? defaultBaseUrlForProvider(provider)
      : submittedBaseUrl || defaultBaseUrlForProvider(provider);
  const opencodeGoBaseUrl = provider === 'opencode-go' ? effectiveBaseUrl : 'http://127.0.0.1:4096';

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROVIDER: provider,
    GAME_SERVER: optionalString(raw, 'gameServer', 'http://127.0.0.1:8787'),
    WEB_BASE_URL: optionalString(raw, 'webBaseUrl', 'http://localhost:5173'),
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
    OPENAI_BASE_URL: effectiveBaseUrl,
    OPENCODE_GO_BASE_URL: opencodeGoBaseUrl,
    OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode',
    MODEL: optionalString(raw, 'model', 'MiniMax-M2.7-highspeed'),
    MODEL_TEMPERATURE: optionalString(raw, 'modelTemperature', '1'),
    MODEL_TOP_P: optionalString(raw, 'modelTopP', '0.95'),
    MODEL_MAX_COMPLETION_TOKENS: optionalString(raw, 'modelMaxCompletionTokens', '1024'),
    MODEL_REASONING_SPLIT: optionalBoolean(raw, 'modelReasoningSplit', true) ? 'true' : 'false',
    MODEL_REASONING_EFFORT: optionalString(raw, 'modelReasoningEffort'),
  };

  for (const savedProvider of Object.keys(SECRET_ENV_BY_PROVIDER) as SecretProvider[]) {
    const envName = SECRET_ENV_BY_PROVIDER[savedProvider];
    if (savedSecrets[savedProvider] && !env[envName]) env[envName] = savedSecrets[savedProvider];
  }
  if (opencodeGoKeyFile && !env.OPENCODE_GO_API_KEY) env.OPENCODE_GO_API_KEY = opencodeGoKeyFile;

  if (apiKey) {
    if (provider === 'minimax') env.MINIMAX_API_KEY = apiKey;
    if (provider === 'openai-compatible') env.OPENAI_API_KEY = apiKey;
    if (provider === 'opencode-go') env.OPENCODE_GO_API_KEY = apiKey;
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
    modelTemperature: env.MODEL_TEMPERATURE ?? '',
    modelTopP: env.MODEL_TOP_P ?? '',
    modelMaxCompletionTokens: env.MODEL_MAX_COMPLETION_TOKENS ?? '',
    modelReasoningSplit: env.MODEL_REASONING_SPLIT !== 'false',
    modelReasoningEffort: env.MODEL_REASONING_EFFORT ?? '',
    apiKeyProvided: Boolean(apiKey || (provider !== 'scripted' && env[SECRET_ENV_BY_PROVIDER[secretProvider(provider)]])),
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
  const bots = parseBots(raw.bots);
  if (bots) await hydrateAndPersistBotKeys(bots);
  await persistGlobalKeyFromRun(raw);
  validateBotProviderSecrets(raw, bots ?? []);
  try { await writeLocalConfig({ defaults: sanitizeConfigDefaults(raw), bots: bots ?? [] }); } catch { /* config persistence is best-effort */ }
  const effectiveRaw: Record<string, unknown> = { ...raw };
  if (bots) {
    effectiveRaw.botConfig = await writeGeneratedBotConfig(runId, bots);
    effectiveRaw.botCount = String(bots.length);
  }
  const { env, publicConfig } = await envFromConfig(effectiveRaw, runId);
  if (bots) Object.assign(env, envForBotApiKeys(bots));
  if (bots) publicConfig.inlineBots = String(bots.length);
  if (runUsesOpenCodeGo(effectiveRaw, bots ?? [])) await assertOpenCodeServerReady(env);
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
  const secretsFile = await readSecretsFile();
  const localSecrets = await localSecretStatus(secretsFile.providers);
  const localBotSecrets = Object.keys(secretsFile.bots);
  const savedConfig = await readLocalConfig();
  const botMeta = botMetaMap(secretsFile.bots);
  const baseDefaults: Record<string, string | boolean> = {
    provider: 'scripted',
    gameServer: 'http://127.0.0.1:8787',
    webBaseUrl: 'http://localhost:5173',
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
    modelTemperature: '1',
    modelTopP: '0.95',
    modelMaxCompletionTokens: '1024',
    modelReasoningSplit: true,
    modelReasoningEffort: '',
  };
  const defaults = { ...baseDefaults, ...(savedConfig?.defaults ?? {}) };
  const sourceBots = savedConfig?.bots && savedConfig.bots.length > 0 ? savedConfig.bots : await loadDefaultBots();
  const bots = sourceBots.map((bot) => {
    const meta = botMeta[bot.id];
    if (meta && meta.provider && !bot.provider) {
      return { ...bot, provider: meta.provider, model: bot.model || meta.model };
    }
    return bot;
  });
  sendJson(res, 200, {
    botConfigs: await botConfigOptions(),
    bots,
    runtime: {
      runtimeDir: DEFAULT_RUNTIME_DIR,
      runtimeCommand: 'npm run dev',
    },
    defaults,
    localSecrets,
    localBotSecrets,
    savedKeys: secretsFile.providers,
    savedBotKeys: botKeyMap(secretsFile.bots),
    savedBotMeta: botMeta,
  });
}

async function sendSecretStatus(res: ServerResponse): Promise<void> {
  const secretsFile = await readSecretsFile();
  sendJson(res, 200, { localSecrets: await localSecretStatus(secretsFile.providers), localBotSecrets: Object.keys(secretsFile.bots), savedKeys: secretsFile.providers, savedBotKeys: botKeyMap(secretsFile.bots), savedBotMeta: botMetaMap(secretsFile.bots) });
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
    if (req.method === 'GET' && url.pathname === '/api/secrets/status') {
      await sendSecretStatus(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/secrets') {
      const body = await readBody(req);
      if (!isRecord(body)) throw new Error('Secret payload must be an object');
      const provider = secretProvider(optionalString(body, 'provider'));
      await saveLocalSecret(provider, optionalString(body, 'apiKey'));
      await sendSecretStatus(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/secrets/bot') {
      const body = await readBody(req);
      if (!isRecord(body)) throw new Error('Bot secret payload must be an object');
      const botId = optionalString(body, 'botId');
      const apiKey = optionalString(body, 'apiKey');
      const botProvider = optionalString(body, 'provider');
      const botModel = optionalString(body, 'model');
      if (!botId) throw new Error('botId is required to save a bot key');
      if (!apiKey) throw new Error('apiKey is required to save a bot key');
      await saveLocalBotSecrets({ [botId]: { key: apiKey, provider: botProvider || undefined, model: botModel || undefined } });
      await sendSecretStatus(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      if (!isRecord(body)) throw new Error('Config payload must be an object');
      const defaults = sanitizeConfigDefaults(isRecord(body.defaults) ? body.defaults : {});
      const bots = parseBots(body.bots) ?? [];
      await writeLocalConfig({ defaults, bots });
      sendJson(res, 200, { ok: true });
      return;
    }
    const secretDeleteMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)$/);
    if (req.method === 'DELETE' && secretDeleteMatch?.[1]) {
      await deleteLocalSecret(secretProvider(secretDeleteMatch[1]));
      await sendSecretStatus(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/runtime/status') {
      sendJson(res, 200, await runtimeStatus(url.searchParams.get('gameServer') ?? 'http://127.0.0.1:8787'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/runtime/start') {
      sendJson(res, 200, await startRuntime(await readBody(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/runtime/stop') {
      sendJson(res, 200, stopRuntime());
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
    textarea { width: 100%; min-height: 86px; resize: vertical; border: 1px solid var(--line); background: #100e0a; color: var(--ink); padding: 10px 11px; font: inherit; font-size: 12px; outline: none; }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(243,184,91,.16); }
    .bot-card { border: 1px solid rgba(243, 184, 91, .2); padding: 12px; display: grid; gap: 10px; background: rgba(0,0,0,.16); }
    .bot-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .bot-card-head strong { color: var(--accent); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
    .runtime-line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
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
        <div class="fieldset"><h2>Game runtime</h2>
          <label>Runtime directory <input name="runtimeDir" /></label>
          <label>Runtime command <select name="runtimeCommand"><option value="npm run dev">npm run dev</option><option value="npm run dev --workspace=packages/workers-server">npm run dev --workspace=packages/workers-server</option></select></label>
          <div class="runtime-line"><button class="secondary" id="runtime-status" type="button">Check runtime</button><button class="secondary" id="runtime-start" type="button">Start runtime only</button><button class="secondary" id="runtime-start-run" type="button">Start runtime + run</button><button class="secondary" id="runtime-stop" type="button">Stop runtime</button></div>
          <p class="note" id="runtime-note">Runtime not checked yet. Starting runtime only starts the game server; it does not create a lobby or harness run.</p>
        </div>
        <div class="fieldset"><h2>Run</h2>
          <label>Run ID <input name="runId" placeholder="gui-smoke-run" /></label>
          <div class="row"><label>Game server <input name="gameServer" /></label><label>Web URL <input name="webBaseUrl" /></label></div>
          <div class="row"><label>Game type <input name="gameType" /></label><label>Bot config <select name="botConfig"></select></label></div>
          <div class="row"><label>Max gameplay rounds after setup <input name="rounds" inputmode="numeric" /></label><label>Communication sweeps <input name="communicationSweeps" inputmode="numeric" /></label></div>
          <label class="check"><input type="checkbox" name="appendAddressSuffix" /> Append wallet suffix to bot names</label>
        </div>
        <div class="fieldset"><h2>Bots + personas</h2>
          <p class="note">Edit each bot directly here. On run start, the GUI writes an ignored per-run bot config under <code>runs/gui-configs/</code> and passes it to the harness.</p>
          <p class="note">For mixed-model runs, set provider/model/API key on each bot. If a bot has an API key, its provider must be minimax, opencode-go, or openai-compatible; scripted ignores model APIs.</p>
          <p class="note">Per-bot API keys are saved locally on this machine (~/.config/coordination-games-model-harness/secrets.json, owner-only) so they persist across page refreshes and GUI restarts. They are never written to bot config files, run metadata, or artifacts. Leave a saved bot's key blank to reuse it.</p>
          <div id="bot-editor" style="display:grid;gap:12px"></div>
          <div class="runtime-line"><button class="secondary" id="add-bot" type="button">Add bot</button><button class="secondary" id="reset-bots" type="button">Reset example bots</button></div>
        </div>
        <div class="fieldset"><h2>Provider</h2>
          <div class="row"><label>Provider <select name="provider"><option value="scripted">scripted</option><option value="minimax">minimax</option><option value="opencode-go">opencode-go</option><option value="openai-compatible">openai-compatible</option></select></label><label>Model <input name="model" list="models-minimax" /></label></div>
          <datalist id="models-minimax">${MINIMAX_MODEL_EXAMPLES.map((model) => `<option value="${model}"></option>`).join('')}</datalist>
          <datalist id="models-opencode-go">${OPENCODE_GO_MODEL_EXAMPLES.map((model) => `<option value="${model}"></option>`).join('')}</datalist>
          <datalist id="models-openai-compatible">${OPENAI_COMPATIBLE_MODEL_EXAMPLES.map((model) => `<option value="${model}"></option>`).join('')}</datalist>
          <p class="note">MiniMax model names must be exact IDs. Do not use shorthand like <code>M3</code>. OpenCode Go models use IDs like <code>opencode-go/minimax-m3</code>.</p>
          <label>OpenAI-compatible base URL <input name="openAiBaseUrl" /></label>
          <div class="row"><label>Temperature <input name="modelTemperature" /></label><label>Top P <input name="modelTopP" /></label></div>
          <div class="row"><label>Max tokens <input name="modelMaxCompletionTokens" inputmode="numeric" /></label><label>Reasoning effort <input name="modelReasoningEffort" placeholder="provider-specific" /></label></div>
          <label class="check"><input type="checkbox" name="modelReasoningSplit" /> Request reasoning split when provider supports it</label>
          <label>API key <input name="apiKey" type="password" autocomplete="off" placeholder="blank uses saved local key when available" /></label>
          <div class="runtime-line"><button class="secondary" id="save-api-key" type="button">Save key locally</button><button class="secondary" id="clear-api-key" type="button">Clear saved key</button></div>
          <label>Pull from saved keys <select id="saved-key-picker"><option value="">— saved keys —</option></select></label>
          <p class="note" id="api-key-note">Saved key status not checked yet.</p>
          <label>Inspector token <input name="inspectorToken" type="password" autocomplete="off" /></label>
        </div>
        <div class="fieldset"><h2>Safety + artifacts</h2>
          <div class="row"><label>Timeout ms <input name="modelTimeoutMs" inputmode="numeric" /></label><label>Retries <input name="modelRetries" inputmode="numeric" /></label></div>
          <label>Results dir <input name="resultsDir" /></label>
          <div class="row"><label>Max cost USD <input name="maxCostUsd" /></label><label>Prompt $ / 1M <input name="promptUsdPer1M" /></label></div>
          <label>Completion $ / 1M <input name="completionUsdPer1M" /></label>
          <label class="check"><input type="checkbox" name="artifactsEnabled" /> Write artifacts</label>
        </div>
        <button id="start-button" type="submit">Start run — creates lobby/game</button>
        <p class="note">Secrets are never written to generated config files, run metadata, or artifacts. They are passed to the harness subprocess only for the selected run.</p>
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
const botEditor = document.querySelector('#bot-editor');
const runtimeNote = document.querySelector('#runtime-note');
const apiKeyNote = document.querySelector('#api-key-note');
let runs = [];
let defaultBots = [];
let bots = [];
let localSecrets = {};
let localBotSecrets = [];
let savedKeys = {};
let savedBotKeys = {};
let savedBotMeta = {};
let activeRunId = null;
let source = null;

function field(name) { return form.elements.namedItem(name); }
function setValue(name, value) { const el = field(name); if (!el) return; if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value ?? ''; }
function valueOf(name) { const el = field(name); if (!el) return ''; return el.type === 'checkbox' ? el.checked : el.value; }
function lineClass(stream) { return stream === 'stderr' ? 'stderr' : stream === 'system' ? 'system' : 'stdout'; }
function escapeHtml(text) { return String(text).replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }
function modelListForProvider(provider) { return provider === 'minimax' ? 'models-minimax' : provider === 'opencode-go' ? 'models-opencode-go' : provider === 'openai-compatible' ? 'models-openai-compatible' : ''; }
function modelPlaceholderForProvider(provider) { return provider === 'minimax' ? 'MiniMax-M3' : provider === 'opencode-go' ? 'opencode-go/minimax-m3' : provider === 'openai-compatible' ? 'custom model id, e.g. gpt-4.1' : 'ignored for scripted'; }
function defaultModelForProvider(provider) { return provider === 'opencode-go' ? 'opencode-go/minimax-m3' : provider === 'minimax' ? 'MiniMax-M3' : valueOf('model'); }
function defaultBaseUrlForProvider(provider) { return provider === 'opencode-go' ? 'http://127.0.0.1:4096' : provider === 'minimax' ? 'https://api.minimax.io/v1' : valueOf('openAiBaseUrl'); }
function knownProviderModels() { return ['MiniMax-M3', 'MiniMax-M2.7-highspeed', 'opencode-go/minimax-m3', 'opencode-go/minimax-m2.7']; }
function applyProviderDefaults() {
  const provider = valueOf('provider');
  const model = valueOf('model');
  if (!model || knownProviderModels().includes(model)) setValue('model', defaultModelForProvider(provider));
  const baseUrl = valueOf('openAiBaseUrl');
  if (!baseUrl || baseUrl === 'https://api.minimax.io/v1' || baseUrl === 'https://api.opencode.ai/v1' || baseUrl === 'http://127.0.0.1:4096') setValue('openAiBaseUrl', defaultBaseUrlForProvider(provider));
}
function keyProvider(provider) { return provider === 'minimax' || provider === 'opencode-go' || provider === 'openai-compatible' ? provider : ''; }
function refreshApiKeyNote() {
  const provider = keyProvider(valueOf('provider'));
  if (!provider) {
    apiKeyNote.textContent = 'Scripted does not use API keys.';
    return;
  }
  if (provider === 'opencode-go') {
    apiKeyNote.textContent = localSecrets[provider]
      ? 'OpenCode Go key detected locally. Runs use the local OpenCode server at the base URL; if that server requires Basic auth, start the GUI with OPENCODE_SERVER_PASSWORD available.'
      : 'OpenCode Go runs use the local OpenCode server. Configure your subscription in OpenCode (for example ~/.config/opencode/opencode-go-api-key), then leave this field blank.';
    return;
  }
  apiKeyNote.textContent = localSecrets[provider]
    ? 'Saved local key available for ' + provider + '. Leave API key blank to reuse it.'
    : 'No saved local key for ' + provider + '. Paste a key once and click Save key locally.';
}
function maskKey(k){ return !k ? '' : (k.length <= 4 ? '••••' : '••••' + k.slice(-4)); }
function rebuildKeyPicker(){
  const picker = document.querySelector('#saved-key-picker');
  if (!picker) return;
  const opts = ['<option value="">— pull from a saved key —</option>'];
  for (const [prov, val] of Object.entries(savedKeys)) { if (val) opts.push('<option value="provider:' + escapeHtml(prov) + '">' + escapeHtml(prov + ' · ' + maskKey(val)) + '</option>'); }
  for (const [botId, val] of Object.entries(savedBotKeys)) { if (val) { const m = savedBotMeta[botId] || {}; const label = (m.provider || 'unknown provider') + (m.model ? ' / ' + m.model : '') + ' · bot ' + botId + ' · ' + maskKey(val); opts.push('<option value="bot:' + escapeHtml(botId) + '">' + escapeHtml(label) + '</option>'); } }
  picker.innerHTML = opts.join('');
}
function populateKeyFields(){
  const prov = keyProvider(valueOf('provider'));
  setValue('apiKey', prov && savedKeys[prov] ? savedKeys[prov] : '');
  botEditor.querySelectorAll('.bot-card').forEach(card => {
    const idEl = card.querySelector('[data-bot-field="id"]');
    const keyEl = card.querySelector('[data-bot-field="apiKey"]');
    if (idEl && keyEl) { const k = savedBotKeys[idEl.value.trim()]; keyEl.value = k || ''; }
  });
}
function populateSavedKeys(){ rebuildKeyPicker(); populateKeyFields(); }
const CONFIG_FIELDS = ['provider','model','openAiBaseUrl','gameServer','webBaseUrl','gameType','botCount','teamSize','rounds','communicationSweeps','modelTimeoutMs','modelRetries','artifactsEnabled','resultsDir','maxCostUsd','promptUsdPer1M','completionUsdPer1M','botConfig','appendAddressSuffix','modelTemperature','modelTopP','modelMaxCompletionTokens','modelReasoningSplit','modelReasoningEffort'];
function consoleConfigPayload(){
  const defaults = {};
  for (const name of CONFIG_FIELDS) { if (field(name)) defaults[name] = valueOf(name); }
  const bots = collectBots().map(bot => Object.assign({}, bot, { apiKey: '' }));
  return { defaults, bots };
}
let configSaveTimer = null;
function scheduleConfigSave(){
  if (configSaveTimer) clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => { fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(consoleConfigPayload()) }).catch(() => {}); }, 400);
}
async function loadSecretStatus() {
  const response = await fetch('/api/secrets/status');
  const data = await response.json();
  localSecrets = data.localSecrets || {};
  localBotSecrets = data.localBotSecrets || localBotSecrets;
  savedKeys = data.savedKeys || {};
  savedBotKeys = data.savedBotKeys || {};
  savedBotMeta = data.savedBotMeta || {};
  rebuildKeyPicker();
  refreshApiKeyNote();
}
async function saveApiKey() {
  const provider = keyProvider(valueOf('provider'));
  if (!provider) throw new Error('Choose minimax, opencode-go, or openai-compatible before saving a key.');
  const apiKey = valueOf('apiKey');
  if (!apiKey) throw new Error('Paste an API key before saving.');
  const response = await fetch('/api/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, apiKey }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to save API key');
  localSecrets = data.localSecrets || {};
  savedKeys = data.savedKeys || savedKeys;
  savedBotKeys = data.savedBotKeys || savedBotKeys;
  savedBotMeta = data.savedBotMeta || savedBotMeta;
  rebuildKeyPicker();
  refreshApiKeyNote();
}
async function clearApiKey() {
  const provider = keyProvider(valueOf('provider'));
  if (!provider) throw new Error('Choose minimax, opencode-go, or openai-compatible before clearing a key.');
  const response = await fetch('/api/secrets/' + encodeURIComponent(provider), { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to clear API key');
  localSecrets = data.localSecrets || {};
  savedKeys = data.savedKeys || {};
  savedBotKeys = data.savedBotKeys || savedBotKeys;
  savedBotMeta = data.savedBotMeta || savedBotMeta;
  setValue('apiKey', '');
  rebuildKeyPicker();
  refreshApiKeyNote();
}
function refreshModelSuggestions() {
  const globalProvider = valueOf('provider') || 'scripted';
  const globalModel = field('model');
  if (globalModel) {
    const listId = modelListForProvider(globalProvider);
    if (listId) globalModel.setAttribute('list', listId); else globalModel.removeAttribute('list');
    globalModel.placeholder = modelPlaceholderForProvider(globalProvider);
  }
  refreshApiKeyNote();
  botEditor.querySelectorAll('.bot-card').forEach(card => {
    const provider = card.querySelector('[data-bot-field="provider"]').value || globalProvider;
    const model = card.querySelector('[data-bot-field="model"]');
    const listId = modelListForProvider(provider);
    if (listId) model.setAttribute('list', listId); else model.removeAttribute('list');
    model.placeholder = provider === globalProvider ? 'inherit global' : modelPlaceholderForProvider(provider);
  });
}

function blankBot(index) { return { name: 'Harness Bot ' + (index + 1), id: 'bot-' + (index + 1), title: 'Custom persona', instruction: 'Play the game according to your persona.', publicStyle: 'I am ready to coordinate.', privateStyle: 'I am looking for reliable partners.', provider: '', model: '', baseUrl: '', apiKeyEnv: '', apiKey: '', temperature: '', topP: '', maxCompletionTokens: '', reasoningSplit: '', reasoningEffort: '' }; }
function providerOptions(value) { return ['', 'scripted', 'minimax', 'opencode-go', 'openai-compatible'].map(option => '<option value="' + option + '"' + (option === value ? ' selected' : '') + '>' + (option || 'inherit global') + '</option>').join(''); }
function reasoningSplitOptions(value) { return ['', 'true', 'false'].map(option => '<option value="' + option + '"' + (option === value ? ' selected' : '') + '>' + (option || 'inherit global') + '</option>').join(''); }
function renderBots() {
  botEditor.innerHTML = bots.map((bot, index) => '<div class="bot-card" data-index="' + index + '"><div class="bot-card-head"><strong>Bot ' + (index + 1) + '</strong><button class="secondary remove-bot" type="button">Remove</button></div><div class="row"><label>Name <input data-bot-field="name" value="' + escapeHtml(bot.name) + '" /></label><label>ID <input data-bot-field="id" value="' + escapeHtml(bot.id) + '" /></label></div><label>Title <input data-bot-field="title" value="' + escapeHtml(bot.title) + '" /></label><label>Instruction <textarea data-bot-field="instruction">' + escapeHtml(bot.instruction) + '</textarea></label><label>Public style <textarea data-bot-field="publicStyle">' + escapeHtml(bot.publicStyle) + '</textarea></label><label>Private style <textarea data-bot-field="privateStyle">' + escapeHtml(bot.privateStyle) + '</textarea></label><div class="row"><label>Provider override <select data-bot-field="provider">' + providerOptions(bot.provider || '') + '</select></label><label>Model override <input data-bot-field="model" value="' + escapeHtml(bot.model || '') + '" placeholder="inherit global" /></label></div><label>Base URL override <input data-bot-field="baseUrl" value="' + escapeHtml(bot.baseUrl || '') + '" placeholder="inherit global" /></label><label>API key for this bot <input data-bot-field="apiKey" type="password" autocomplete="off" value="' + escapeHtml(savedBotKeys[bot.id] || '') + '" placeholder="' + (savedBotKeys[bot.id] ? 'saved locally — shown as dots' : 'paste once, then click Save key') + '" /></label><button class="secondary save-bot-key" type="button">Save key</button><div class="row"><label>API key env var <input data-bot-field="apiKeyEnv" value="' + escapeHtml(bot.apiKeyEnv || '') + '" placeholder="auto if key is entered" /></label><label>Reasoning effort <input data-bot-field="reasoningEffort" value="' + escapeHtml(bot.reasoningEffort || '') + '" placeholder="provider-specific" /></label></div><div class="row"><label>Temperature <input data-bot-field="temperature" value="' + escapeHtml(bot.temperature || '') + '" placeholder="inherit" /></label><label>Top P <input data-bot-field="topP" value="' + escapeHtml(bot.topP || '') + '" placeholder="inherit" /></label></div><div class="row"><label>Max tokens <input data-bot-field="maxCompletionTokens" value="' + escapeHtml(bot.maxCompletionTokens || '') + '" placeholder="inherit" /></label><label>Reasoning split <select data-bot-field="reasoningSplit">' + reasoningSplitOptions(bot.reasoningSplit || '') + '</select></label></div></div>').join('');
  refreshModelSuggestions();
}
function collectBots() {
  return [...botEditor.querySelectorAll('.bot-card')].map((card, index) => {
    const read = name => card.querySelector('[data-bot-field="' + name + '"]').value.trim();
    return { name: read('name') || 'Harness Bot ' + (index + 1), id: read('id') || 'bot-' + (index + 1), title: read('title') || 'Custom persona', instruction: read('instruction') || 'Play the game according to your persona.', publicStyle: read('publicStyle'), privateStyle: read('privateStyle'), provider: read('provider'), model: read('model'), baseUrl: read('baseUrl'), apiKeyEnv: read('apiKeyEnv'), apiKey: read('apiKey'), temperature: read('temperature'), topP: read('topP'), maxCompletionTokens: read('maxCompletionTokens'), reasoningSplit: read('reasoningSplit'), reasoningEffort: read('reasoningEffort') };
  });
}
function runtimePayload() { return { runtimeDir: valueOf('runtimeDir'), runtimeCommand: valueOf('runtimeCommand'), gameServer: valueOf('gameServer') }; }
function showRunError(message) {
  serverStatus.textContent = 'error';
  meta.innerHTML = '<strong>Run blocked before start</strong><span>' + escapeHtml(message) + '</span>';
  terminal.innerHTML = '<span class="stderr">[error] ' + escapeHtml(message) + '</span>';
}
function runPayload() {
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.appendAddressSuffix = valueOf('appendAddressSuffix');
  payload.artifactsEnabled = valueOf('artifactsEnabled');
  payload.bots = collectBots();
  payload.botCount = String(payload.bots.length);
  return payload;
}
function validateRunPayloadClient(payload) {
  const globalProvider = payload.provider || 'scripted';
  const scriptedBots = payload.bots.filter(bot => (bot.provider || globalProvider) === 'scripted').map((bot, index) => 'Bot ' + (index + 1) + ' (' + bot.name + ')');
  if (scriptedBots.length) throw new Error('This run still has scripted bots: ' + scriptedBots.join(', ') + '. For a model game, set the top-level Provider to minimax and enter the API key there so all bots inherit it, or set provider/model/API key on every bot.');
  const usesModelProvider = globalProvider !== 'scripted' || payload.bots.some(bot => (bot.provider || globalProvider) !== 'scripted');
  const rounds = Number.parseInt(payload.rounds || '12', 10);
  if (usesModelProvider && (!Number.isFinite(rounds) || rounds < 1)) throw new Error('Rounds is set to 0, so this only creates a lobby/game and makes zero model calls. Set Rounds to at least 1 for an actual model test.');
}
function applyRuntimeStatus(status) {
  if (status.effectiveGameServer && status.effectiveGameServer !== valueOf('gameServer')) setValue('gameServer', status.effectiveGameServer);
  const server = status.effectiveGameServer || valueOf('gameServer');
  const detected = status.detectedServerUrl && status.detectedServerUrl !== status.requestedGameServer ? ' Wrangler selected ' + status.detectedServerUrl + '; the Run Game server field was updated.' : '';
  runtimeNote.textContent = status.serverReachable ? 'Game server reachable at ' + server + '. Runtime status: ' + status.status + '. Runtime-only does not create a lobby; use Start run to create one.' + detected : 'Game server NOT reachable at ' + valueOf('gameServer') + '. Runtime status: ' + status.status + (status.serverError ? ' · ' + status.serverError : '') + '. Start runtime only starts the server; Start run creates the lobby/game.' + detected;
}
async function refreshRuntimeStatus() {
  const response = await fetch('/api/runtime/status?gameServer=' + encodeURIComponent(valueOf('gameServer')));
  const status = await response.json();
  applyRuntimeStatus(status);
  return status;
}
async function startRuntime() {
  runtimeNote.textContent = 'Starting runtime...';
  const response = await fetch('/api/runtime/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(runtimePayload()) });
  const status = await response.json();
  if (!response.ok) throw new Error(status.error || 'Runtime failed to start');
  applyRuntimeStatus(status);
  runtimeNote.textContent += ' Rechecking for Wrangler ready URL...';
  setTimeout(refreshRuntimeStatus, 1800);
}
async function stopRuntime() {
  await fetch('/api/runtime/stop', { method: 'POST' });
  await refreshRuntimeStatus();
}
async function submitRun() {
  startButton.disabled = true;
  serverStatus.textContent = 'starting';
  const payload = runPayload();
  try {
    validateRunPayloadClient(payload);
    const status = await refreshRuntimeStatus();
    if (status.serverReachable && status.effectiveGameServer) payload.gameServer = status.effectiveGameServer;
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const run = await response.json();
    if (!response.ok) throw new Error(run.error || 'Run failed to start');
    runs.unshift(run); activeRunId = run.id; attachEvents(run.id); renderRuns(); renderActive(run); serverStatus.textContent = 'running';
  } catch (error) { showRunError(error.message); }
  finally {
    startButton.disabled = false;
    await loadSecretStatus();
    populateKeyFields();
  }
}
async function waitForRuntimeReady(timeoutMs = 45000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let status = await refreshRuntimeStatus();
  while (!status.serverReachable && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    status = await refreshRuntimeStatus();
  }
  return status;
}
async function startRuntimeThenRun() {
  validateRunPayloadClient(runPayload());
  await startRuntime();
  const status = await waitForRuntimeReady();
  if (!status.serverReachable) throw new Error('Runtime started, but no reachable game server was detected yet. Check the runtime logs and retry Start run.');
  await submitRun();
}

function renderRuns() {
  runList.innerHTML = runs.map(run => '<div class="run-card ' + (run.id === activeRunId ? 'active' : '') + '" data-id="' + run.id + '"><span class="pill ' + run.status + '">' + run.status + '</span><div style="margin-top:8px">' + run.id + '</div><div class="note">' + run.config.provider + ' · ' + run.config.model + '</div></div>').join('');
}
function logKey(entry) {
  return [entry.timestamp || '', entry.stream || '', entry.text || ''].join('\u0000');
}
function mergeRunLogs(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...(existing || []), ...(incoming || [])]) {
    const key = logKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
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
    if (idx >= 0) {
      run.logs = mergeRunLogs(runs[idx].logs, run.logs);
      runs[idx] = run;
    } else {
      runs.unshift(run);
    }
    renderRuns(); renderActive(run);
  });
  source.addEventListener('log', event => {
    const entry = JSON.parse(event.data);
    const run = runs.find(item => item.id === runId);
    if (!run) return;
    run.logs = run.logs || [];
    if (!run.logs.some(existing => logKey(existing) === logKey(entry))) run.logs.push(entry);
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
botEditor.addEventListener('click', event => {
  const remove = event.target.closest('.remove-bot');
  if (!remove) return;
  const card = event.target.closest('.bot-card');
  const index = Number(card.dataset.index);
  bots = collectBots().filter((_, botIndex) => botIndex !== index);
  renderBots();
  scheduleConfigSave();
});
document.querySelector('#add-bot').addEventListener('click', () => {
  bots = collectBots();
  bots.push(blankBot(bots.length));
  renderBots();
  scheduleConfigSave();
});
document.querySelector('#reset-bots').addEventListener('click', () => {
  bots = defaultBots.map(bot => ({ ...bot }));
  renderBots();
  scheduleConfigSave();
});
field('provider').addEventListener('change', () => { applyProviderDefaults(); refreshModelSuggestions(); populateKeyFields(); });
botEditor.addEventListener('change', event => {
  if (event.target.matches('[data-bot-field="provider"]')) refreshModelSuggestions();
});
document.querySelector('#save-api-key').addEventListener('click', () => { saveApiKey().catch(error => { apiKeyNote.textContent = error.message; }); });
document.querySelector('#clear-api-key').addEventListener('click', () => { clearApiKey().catch(error => { apiKeyNote.textContent = error.message; }); });
document.querySelector('#runtime-status').addEventListener('click', () => { void refreshRuntimeStatus(); });
document.querySelector('#runtime-start').addEventListener('click', () => { startRuntime().catch(error => { runtimeNote.textContent = error.message; }); });
document.querySelector('#runtime-start-run').addEventListener('click', () => { startRuntimeThenRun().catch(error => { runtimeNote.textContent = error.message; serverStatus.textContent = error.message; }); });
document.querySelector('#runtime-stop').addEventListener('click', () => { stopRuntime().catch(error => { runtimeNote.textContent = error.message; }); });
document.querySelector('#saved-key-picker').addEventListener('change', event => {
  const v = event.target.value;
  if (!v) return;
  const idx = v.indexOf(':');
  const kind = v.slice(0, idx);
  const id = v.slice(idx + 1);
  const key = kind === 'provider' ? savedKeys[id] : savedBotKeys[id];
  if (key) { setValue('apiKey', key); apiKeyNote.textContent = 'Loaded saved key ' + maskKey(key) + ' into the API key field.'; }
});
botEditor.addEventListener('click', async event => {
  const btn = event.target.closest('.save-bot-key');
  if (!btn) return;
  const card = event.target.closest('.bot-card');
  const botId = card.querySelector('[data-bot-field="id"]').value.trim();
  const apiKey = card.querySelector('[data-bot-field="apiKey"]').value.trim();
  const botProvider = (card.querySelector('[data-bot-field="provider"]').value || valueOf('provider')).trim();
  const botModel = (card.querySelector('[data-bot-field="model"]').value || defaultModelForProvider(botProvider)).trim();
  if (!botId) { apiKeyNote.textContent = 'Give the bot an ID before saving its key.'; return; }
  if (!apiKey) { apiKeyNote.textContent = 'Paste a key in this bot before saving.'; return; }
  try {
    const response = await fetch('/api/secrets/bot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, apiKey, provider: botProvider, model: botModel }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to save bot key');
    savedKeys = data.savedKeys || savedKeys;
    savedBotKeys = data.savedBotKeys || savedBotKeys;
    savedBotMeta = data.savedBotMeta || savedBotMeta;
    localBotSecrets = data.localBotSecrets || localBotSecrets;
    rebuildKeyPicker();
    apiKeyNote.textContent = 'Saved key for bot ' + botId + (botProvider ? ' (' + botProvider + (botModel ? ' / ' + botModel : '') + ')' : '') + ' · ' + maskKey(apiKey) + '. Persists across refreshes.';
  } catch (error) { apiKeyNote.textContent = error.message; }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  await submitRun();
});
form.addEventListener('input', () => { scheduleConfigSave(); });
form.addEventListener('change', () => { scheduleConfigSave(); });
fetch('/api/defaults').then(res => res.json()).then(data => {
  localSecrets = data.localSecrets || {};
  localBotSecrets = data.localBotSecrets || [];
  savedKeys = data.savedKeys || {};
  savedBotKeys = data.savedBotKeys || {};
  savedBotMeta = data.savedBotMeta || {};
  for (const [key, value] of Object.entries(data.defaults)) setValue(key, value);
  for (const [key, value] of Object.entries(data.runtime)) setValue(key, value);
  const select = field('botConfig');
  select.innerHTML = data.botConfigs.map(value => '<option value="' + value + '">' + value + '</option>').join('');
  setValue('botConfig', data.defaults.botConfig);
  defaultBots = data.bots && data.bots.length ? data.bots : [blankBot(0), blankBot(1), blankBot(2), blankBot(3)];
  bots = defaultBots.map(bot => ({ ...bot }));
  renderBots();
  refreshApiKeyNote();
  populateSavedKeys();
  void refreshRuntimeStatus();
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
