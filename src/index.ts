#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Wallet } from 'ethers';
import { api, asRecord, authenticate, fetchJsonWithRetry, gameApiRetryDefaults } from './api.js';

const SERVER = process.env.GAME_SERVER ?? 'http://127.0.0.1:8787';
const GAME_TYPE = process.env.GAME_TYPE ?? 'tragedy-of-the-commons';
const BOT_COUNT = Number.parseInt(process.env.BOT_COUNT ?? '4', 10);
const TEAM_SIZE = Number.parseInt(process.env.TEAM_SIZE ?? '2', 10);
const MAX_ROUNDS = Number.parseInt(process.env.HARNESS_ROUNDS ?? '24', 10);
const COMMUNICATION_SWEEPS = Number.parseInt(process.env.HARNESS_COMMUNICATION_SWEEPS ?? '1', 10);
const PROVIDER_NAME = process.env.PROVIDER ?? 'scripted';
const MODEL = process.env.MODEL ?? process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7-highspeed';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.minimax.io/v1';
const OPENCODE_GO_BASE_URL = process.env.OPENCODE_GO_BASE_URL ?? 'http://127.0.0.1:4096';
const OPENCODE_GO_AGENT = process.env.OPENCODE_GO_AGENT?.trim() || 'plan';
const MODEL_TEMPERATURE = Number.parseFloat(process.env.MODEL_TEMPERATURE ?? '1');
const MODEL_TOP_P = Number.parseFloat(process.env.MODEL_TOP_P ?? '0.95');
const MODEL_MAX_COMPLETION_TOKENS = Number.parseInt(process.env.MODEL_MAX_COMPLETION_TOKENS ?? '1024', 10);
const MODEL_REASONING_SPLIT = process.env.MODEL_REASONING_SPLIT !== 'false';
const MODEL_REASONING_EFFORT = process.env.MODEL_REASONING_EFFORT?.trim();
const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'http://localhost:5173';
const INSPECTOR_TOKEN = process.env.INSPECTOR_TOKEN ?? 'local-inspector-token';
const BOT_CONFIG_PATH = process.env.BOT_CONFIG;
const APPEND_ADDRESS_SUFFIX = process.env.APPEND_ADDRESS_SUFFIX !== 'false';
const RUN_ID = sanitizeRunId(process.env.HARNESS_RUN_ID ?? randomUUID());
const MODEL_CALL_TIMEOUT_MS = Number.parseInt(process.env.HARNESS_MODEL_TIMEOUT_MS ?? '90000', 10);
const MODEL_CALL_RETRIES = Number.parseInt(process.env.HARNESS_MODEL_RETRIES ?? '1', 10);
const ACTION_CORRECTION_ATTEMPTS = Math.max(2, Number.parseInt(process.env.HARNESS_ACTION_CORRECTION_ATTEMPTS ?? '3', 10));
const RUNTIME_ADVANCE_WAIT_MS = Number.parseInt(process.env.HARNESS_RUNTIME_ADVANCE_WAIT_MS ?? '75000', 10);
const ARTIFACTS_ENABLED = process.env.HARNESS_ARTIFACTS !== '0';
const ARTIFACT_ROOT = process.env.HARNESS_RESULTS_DIR ?? 'runs/model-harness';
const RUN_DIR = path.join(ARTIFACT_ROOT, RUN_ID);
const MAX_COST_USD = Number.parseFloat(process.env.HARNESS_MAX_COST_USD ?? '0');
const PROMPT_USD_PER_1M = Number.parseFloat(process.env.HARNESS_PROMPT_USD_PER_1M ?? '0');
const COMPLETION_USD_PER_1M = Number.parseFloat(process.env.HARNESS_COMPLETION_USD_PER_1M ?? '0');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: npm run harness:model -- [--help]

Environment:
  GAME_SERVER       Coordination Games server URL (default http://127.0.0.1:8787)
  WEB_BASE_URL      Optional web URL used only for final links (default http://localhost:5173)
  INSPECTOR_TOKEN   Admin token for /api/admin/session/:id/inspect (default local-inspector-token)
  GAME_TYPE         Game slug (default tragedy-of-the-commons)
  BOT_COUNT         Number of agents (default 4)
  TEAM_SIZE         Lobby team size (default 2)
  HARNESS_ROUNDS    Max gameplay rounds after setup before stopping (default 24)
  HARNESS_COMMUNICATION_SWEEPS  Chat/DM wake sweeps after each action (default 1)
  HARNESS_RUN_ID    Optional artifact run id; sanitized before use
  HARNESS_MODEL_TIMEOUT_MS      Per-model-call timeout (default 90000)
  HARNESS_MODEL_RETRIES         Retries after timeout/provider errors (default 1)
  HARNESS_RUNTIME_ADVANCE_WAIT_MS Wait for game runtime timeout after model timeout (default 75000)
  HARNESS_ARTIFACTS             0 disables run artifact files (default enabled)
  HARNESS_RESULTS_DIR           Artifact root directory (default runs/model-harness)
  HARNESS_GAME_API_TIMEOUT_MS   Per game-server request timeout (default 10000)
  HARNESS_GAME_API_RETRIES      Retries for transient game-server failures (default 2)
  HARNESS_GAME_API_RETRY_BASE_DELAY_MS Retry backoff base in ms (default 250)
  HARNESS_MAX_COST_USD          Optional hard stop when estimated cost exceeds this value
  HARNESS_PROMPT_USD_PER_1M     Optional prompt-token rate for cost estimates
  HARNESS_COMPLETION_USD_PER_1M Optional completion-token rate for cost estimates
  PROVIDER          scripted | openai-compatible | minimax | opencode-go (default scripted)
  OPENAI_BASE_URL   OpenAI-compatible base URL (MiniMax: https://api.minimax.io/v1)
  OPENCODE_GO_BASE_URL Local OpenCode server URL (default http://127.0.0.1:4096)
  OPENCODE_GO_AGENT OpenCode local server agent for opencode-go (default plan)
  OPENCODE_SERVER_USERNAME Optional Basic auth username for local opencode serve
  OPENCODE_SERVER_PASSWORD Optional Basic auth password for local opencode serve
  OPENAI_API_KEY    API key for openai-compatible
  MINIMAX_API_KEY   Alternative API key env for MiniMax
  MODEL             Model name (MiniMax: MiniMax-M2.7-highspeed)
  MODEL_TEMPERATURE Optional global temperature for OpenAI-compatible calls (default 1)
  MODEL_TOP_P       Optional global top_p for OpenAI-compatible calls (default 0.95)
  MODEL_MAX_COMPLETION_TOKENS Optional global max completion tokens (default 1024)
  MODEL_REASONING_SPLIT       false disables reasoning_split requests (default true)
  MODEL_REASONING_EFFORT      Optional provider-specific reasoning effort string
  BOT_CONFIG        Optional JSON file with { "bots": [...] } or a bot array
  APPEND_ADDRESS_SUFFIX  Append wallet suffix to bot names (default true)

Examples:
  PROVIDER=scripted GAME_SERVER=http://127.0.0.1:8787 npm run harness:model
  PROVIDER=minimax OPENAI_BASE_URL=https://api.minimax.io/v1 MINIMAX_API_KEY=... npm run harness:model
`);
  process.exit(0);
}

interface HarnessBot {
  name: string;
  token: string;
  playerId: string;
  privateKey: string;
  persona: BotPersona;
  providerConfig: ProviderConfig;
}

type ProviderName = 'scripted' | 'openai-compatible' | 'minimax' | 'opencode-go';

interface ProviderConfig {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  apiKeyEnv: string | undefined;
  temperature: number;
  topP: number;
  maxCompletionTokens: number;
  reasoningSplit: boolean;
  reasoningEffort: string | undefined;
}

interface BotPersona {
  id: string;
  title: string;
  instruction: string;
  publicStyle: string;
  privateStyle: string;
}

interface BotRuntimeConfig {
  name: string;
  persona: BotPersona;
  providerConfig: ProviderConfig;
}

interface ModelDecision {
  reasoning: string;
  publicMessage: string;
  privateMessage: string;
  dmRecipient: string | undefined;
  action: Record<string, unknown>;
}

interface WakeContext {
  reason: 'turn' | 'public' | 'private' | 'mixed';
  summary: string;
  privateReplyTo: string | undefined;
  messages: Record<string, unknown>[];
}

interface BotContext {
  visibleState: Record<string, unknown>;
  tools: unknown[];
  relayMessages: Record<string, unknown>[];
  nextRelayCursor: number;
}

interface ProviderInput {
  bot: HarnessBot;
  visibleState: unknown;
  tools: unknown[];
  round: number;
  mode: 'turn' | 'communication';
  wakeContext: WakeContext | undefined;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ProviderUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface ActionSelection {
  toolName: string;
  args: Record<string, unknown>;
}

interface ModelProvider {
  readonly name: ProviderName;
  readonly model: string;
  readonly config: ProviderConfig;
  decide(input: ProviderInput): Promise<ModelDecision>;
  usage?(): ProviderUsage;
}

interface HarnessArtifact {
  schema: 1;
  runId: string;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

interface HarnessArtifactPayload {
  type: string;
  [key: string]: unknown;
}

interface DecisionLabel {
  type: 'turn' | 'communication';
  sweep?: number;
  relayCursor?: string;
}

class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

const BOT_PERSONAS: BotPersona[] = [
  {
    id: 'anti-overextractor',
    title: 'Aggressive anti-overextraction enforcer',
    instruction:
      'Be assertive and confrontational about commons protection. Do not initiate trades. Do not over-extract. Focus on calling out, deterring, and punishing over-extraction while preserving your own position.',
    publicStyle:
      'I will not trade. I am watching extraction closely, and I will call out anyone pushing the commons too hard.',
    privateStyle: 'I am not trading. If someone over-extracts, I want pressure on them immediately.',
  },
  {
    id: 'peaceful-mediator',
    title: 'Very peaceful mediator',
    instruction:
      'Be cooperative, patient, and peace-seeking. Prefer restraint, de-escalation, public agreements, fair trades, and keeping everyone talking before conflict forms.',
    publicStyle:
      'I want us to keep this peaceful and sustainable. Let us agree on restraint before anyone panics.',
    privateStyle: 'I am trying to keep the table calm. Can we build a quiet cooperation pact?',
  },
  {
    id: 'win-focused-builder',
    title: 'Win-focused builder',
    instruction:
      'Be singularly focused on winning through efficient building and positioning. Cooperate only when it improves your score. Prefer trades or restraint only if they accelerate your path to victory.',
    publicStyle:
      'I am playing to win efficiently. I will cooperate when it creates a better path to points.',
    privateStyle:
      'I will back deals that help me build faster. What can you offer that improves my position?',
  },
  {
    id: 'win-focused-opportunist',
    title: 'Win-focused opportunist',
    instruction:
      'Be singularly focused on winning through opportunistic leverage. Watch for weak positions, negotiate hard, and take advantage of openings while avoiding reckless collapse.',
    publicStyle:
      'I am here to win. I will support the table when it benefits my position, but I will not play charity.',
    privateStyle:
      'I am looking for leverage. If we coordinate, it needs to put me closer to winning.',
  },
];

const DEFAULT_BOT_NAMES = ['Alicia Commons', 'Bob Timber', 'Carol Current', 'Dave Ore'];

function defaultBotRuntimeConfig(index: number): BotRuntimeConfig {
  const persona = BOT_PERSONAS[index % BOT_PERSONAS.length];
  if (!persona) throw new Error('At least one bot persona is required');
  return {
    name: DEFAULT_BOT_NAMES[index] ?? `Harness Bot ${index + 1}`,
    persona,
    providerConfig: defaultProviderConfig(),
  };
}

function defaultProviderConfig(): ProviderConfig {
  const provider = normalizeProviderName(PROVIDER_NAME);
  return {
    provider,
    model: MODEL,
    baseUrl: provider === 'opencode-go' ? OPENCODE_GO_BASE_URL : OPENAI_BASE_URL,
    apiKeyEnv: undefined,
    temperature: Number.isFinite(MODEL_TEMPERATURE) ? MODEL_TEMPERATURE : 1,
    topP: Number.isFinite(MODEL_TOP_P) ? MODEL_TOP_P : 0.95,
    maxCompletionTokens: Number.isFinite(MODEL_MAX_COMPLETION_TOKENS) ? MODEL_MAX_COMPLETION_TOKENS : 1024,
    reasoningSplit: MODEL_REASONING_SPLIT,
    reasoningEffort: MODEL_REASONING_EFFORT,
  };
}

function defaultModelForProvider(provider: ProviderName, fallback: ProviderConfig): string {
  if (provider === fallback.provider) return fallback.model;
  if (provider === 'minimax') return 'MiniMax-M2.7-highspeed';
  if (provider === 'opencode-go') return 'opencode-go/minimax-m3';
  if (provider === 'openai-compatible') return 'gpt-4.1';
  return fallback.model;
}

function defaultBaseUrlForProvider(provider: ProviderName, fallback: ProviderConfig): string {
  if (provider === fallback.provider) return fallback.baseUrl;
  if (provider === 'opencode-go') return OPENCODE_GO_BASE_URL;
  if (provider === 'minimax') return 'https://api.minimax.io/v1';
  return OPENAI_BASE_URL;
}

function normalizeProviderName(value: string): ProviderName {
  if (value === 'scripted' || value === 'openai-compatible' || value === 'minimax' || value === 'opencode-go') return value;
  throw new Error(`Unknown provider=${value}`);
}

function optionalNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function optionalInteger(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = optionalNumber(record, key, fallback);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function optionalBooleanValue(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function normalizeProviderConfig(raw: Record<string, unknown>, fallback: ProviderConfig): ProviderConfig {
  const provider = optionalString(raw, 'provider');
  const normalizedProvider = provider ? normalizeProviderName(provider) : fallback.provider;
  const baseUrl = optionalString(raw, 'baseUrl') ?? optionalString(raw, 'openAiBaseUrl') ?? defaultBaseUrlForProvider(normalizedProvider, fallback);
  return {
    provider: normalizedProvider,
    model: optionalString(raw, 'model') ?? defaultModelForProvider(normalizedProvider, fallback),
    baseUrl,
    apiKeyEnv: optionalString(raw, 'apiKeyEnv') ?? fallback.apiKeyEnv,
    temperature: optionalNumber(raw, 'temperature', fallback.temperature),
    topP: optionalNumber(raw, 'topP', fallback.topP),
    maxCompletionTokens: optionalInteger(raw, 'maxCompletionTokens', fallback.maxCompletionTokens),
    reasoningSplit: optionalBooleanValue(raw, 'reasoningSplit', fallback.reasoningSplit),
    reasoningEffort: optionalString(raw, 'reasoningEffort') ?? fallback.reasoningEffort,
  };
}

function publicProviderConfig(config: ProviderConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.provider === 'scripted' ? undefined : config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    temperature: config.temperature,
    topP: config.topP,
    maxCompletionTokens: config.maxCompletionTokens,
    reasoningSplit: config.reasoningSplit,
    reasoningEffort: config.reasoningEffort,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function validateProviderBaseUrl(config: ProviderConfig, apiKeyEnv: string): void {
  if (config.provider === 'scripted') return;
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error(`Invalid provider baseUrl for ${config.provider}: ${config.baseUrl}`);
  }
  if (parsed.username || parsed.password) throw new Error('Provider baseUrl must not include credentials');
  if (parsed.search || parsed.hash) throw new Error('Provider baseUrl must not include query parameters or fragments');
  const isSafeProtocol = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
  if (!isSafeProtocol) throw new Error('Provider baseUrl must use https, except loopback http is allowed for local testing');
  if (!trustedHostForKeyEnv(apiKeyEnv, parsed.hostname)) {
    throw new Error('Custom provider baseUrl requires a harness-scoped HARNESS_*_API_KEY variable; default provider keys are limited to their trusted provider hosts');
  }
}

function validateApiKeyEnvName(value: string): void {
  const allowed = value === 'OPENAI_API_KEY' || value === 'MINIMAX_API_KEY' || value === 'OPENCODE_GO_API_KEY' || /^HARNESS_[A-Z0-9_]*API_KEY$/.test(value);
  if (!allowed) {
    throw new Error('apiKeyEnv must be OPENAI_API_KEY, MINIMAX_API_KEY, OPENCODE_GO_API_KEY, or a harness-scoped HARNESS_*_API_KEY variable');
  }
}

function resolvedApiKeyEnvName(config: ProviderConfig): string {
  if (config.apiKeyEnv) {
    validateApiKeyEnvName(config.apiKeyEnv);
    return config.apiKeyEnv;
  }
  if (config.provider === 'minimax') return 'MINIMAX_API_KEY';
  if (config.provider === 'opencode-go') return 'OPENCODE_GO_API_KEY';
  return 'OPENAI_API_KEY';
}

function trustedHostForKeyEnv(apiKeyEnv: string, hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (apiKeyEnv === 'OPENAI_API_KEY') return normalized === 'api.openai.com';
  if (apiKeyEnv === 'MINIMAX_API_KEY') return normalized === 'api.minimax.io';
  if (apiKeyEnv === 'OPENCODE_GO_API_KEY') return normalized === 'api.opencode.ai' || isLoopbackHost(normalized);
  return /^HARNESS_[A-Z0-9_]*API_KEY$/.test(apiKeyEnv);
}

function normalizeBotRuntimeConfig(raw: unknown, index: number): BotRuntimeConfig {
  const fallback = defaultBotRuntimeConfig(index);
  if (!isRecord(raw)) return fallback;
  return {
    name: optionalString(raw, 'name') ?? fallback.name,
    persona: {
      id: optionalString(raw, 'id') ?? fallback.persona.id,
      title: optionalString(raw, 'title') ?? fallback.persona.title,
      instruction: optionalString(raw, 'instruction') ?? fallback.persona.instruction,
      publicStyle: optionalString(raw, 'publicStyle') ?? fallback.persona.publicStyle,
      privateStyle: optionalString(raw, 'privateStyle') ?? fallback.persona.privateStyle,
    },
    providerConfig: normalizeProviderConfig(raw, fallback.providerConfig),
  };
}

async function loadBotRuntimeConfigs(): Promise<BotRuntimeConfig[]> {
  if (!BOT_CONFIG_PATH) {
    return Array.from({ length: BOT_COUNT }, (_, index) => defaultBotRuntimeConfig(index));
  }
  const raw = await readFile(BOT_CONFIG_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.bots)
      ? parsed.bots
      : null;
  if (!entries || entries.length === 0) {
    throw new Error(`BOT_CONFIG must be a non-empty array or object with a non-empty bots array: ${BOT_CONFIG_PATH}`);
  }
  return entries.map((entry, index) => normalizeBotRuntimeConfig(entry, index));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeRunId(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
  return sanitized || randomUUID();
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(
      /\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s,}]+/gi,
      'apiKey=[REDACTED]',
    );
}

function jsonPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 12_000);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.stack ?? error.message);
  return redactSensitiveText(String(error));
}

async function ensureRunDir(): Promise<void> {
  if (!ARTIFACTS_ENABLED) return;
  await mkdir(RUN_DIR, { recursive: true });
}

async function writeJsonArtifact(fileName: string, value: unknown): Promise<void> {
  if (!ARTIFACTS_ENABLED) return;
  await writeFile(path.join(RUN_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonlArtifact(fileName: string, value: HarnessArtifactPayload): Promise<void> {
  if (!ARTIFACTS_ENABLED) return;
  const event: HarnessArtifact = {
    schema: 1,
    runId: RUN_ID,
    timestamp: new Date().toISOString(),
    ...value,
  };
  await appendFile(path.join(RUN_DIR, fileName), `${JSON.stringify(event)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function emptyUsage(): ProviderUsage {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1_000_000) * PROMPT_USD_PER_1M +
    (completionTokens / 1_000_000) * COMPLETION_USD_PER_1M
  );
}

function providerUsage(provider: ModelProvider): ProviderUsage {
  return provider.usage?.() ?? emptyUsage();
}

function totalUsage(providers: Iterable<ModelProvider>): ProviderUsage {
  const total = emptyUsage();
  for (const provider of providers) {
    const usage = providerUsage(provider);
    total.requests += usage.requests;
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
    total.estimatedCostUsd += usage.estimatedCostUsd;
  }
  return total;
}

function assertCostBudget(providers: Iterable<ModelProvider>): void {
  if (MAX_COST_USD <= 0) return;
  const usage = totalUsage(providers);
  if (usage.estimatedCostUsd > MAX_COST_USD) {
    throw new BudgetExceededError(
      `Harness estimated cost ${usage.estimatedCostUsd.toFixed(6)} exceeded HARNESS_MAX_COST_USD=${MAX_COST_USD}`,
    );
  }
}

async function decideWithRetries(
  provider: ModelProvider,
  input: ProviderInput,
  label: DecisionLabel,
  budgetProviders: Iterable<ModelProvider> = [provider],
): Promise<ModelDecision> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MODEL_CALL_RETRIES; attempt++) {
    try {
      assertCostBudget(budgetProviders);
      const decision = await withTimeout(
        provider.decide(input),
        MODEL_CALL_TIMEOUT_MS,
        `${provider.name} ${input.bot.name} ${label.type} round=${input.round}`,
      );
      assertCostBudget(budgetProviders);
      await appendJsonlArtifact('turns.jsonl', {
        type: 'decision',
        decisionType: label.type,
        sweep: label.sweep,
        relayCursor: label.relayCursor,
        attempt: attempt + 1,
        bot: input.bot.name,
        playerId: input.bot.playerId,
        persona: input.bot.persona.id,
        provider: provider.name,
        model: provider.model,
        providerConfig: publicProviderConfig(provider.config),
        round: input.round,
        action: decision.action,
        publicMessageChars: decision.publicMessage.length,
        privateMessageChars: decision.privateMessage.length,
        usage: providerUsage(provider),
      });
      return decision;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        await appendJsonlArtifact('errors.jsonl', {
          type: 'budget_exceeded',
          decisionType: label.type,
          sweep: label.sweep,
          relayCursor: label.relayCursor,
          attempt: attempt + 1,
          bot: input.bot.name,
          playerId: input.bot.playerId,
          provider: provider.name,
          model: provider.model,
          round: input.round,
          usage: providerUsage(provider),
          aggregateUsage: totalUsage(budgetProviders),
          error: formatError(error),
        });
        throw error;
      }
      lastError = error;
      await appendJsonlArtifact('errors.jsonl', {
        type: 'decision_error',
        decisionType: label.type,
        sweep: label.sweep,
        relayCursor: label.relayCursor,
        attempt: attempt + 1,
        bot: input.bot.name,
        playerId: input.bot.playerId,
        provider: provider.name,
        model: provider.model,
        round: input.round,
        error: formatError(error),
      });
      if (attempt >= MODEL_CALL_RETRIES) break;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isMessagingRelay(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message.type === 'messaging';
}

function isSystemRelay(message: Record<string, unknown>): boolean {
  return message.sender === 'system';
}

function isDmRelay(message: Record<string, unknown>): boolean {
  return isRecord(message.scope) && message.scope.kind === 'dm';
}

function relayFeedStateForModelPrompt(
  visibleState: unknown,
  wakeContext: WakeContext | undefined,
): unknown {
  if (!isRecord(visibleState)) return visibleState;
  const newRelayMessages = Array.isArray(visibleState.newRelayMessages)
    ? visibleState.newRelayMessages.filter(isRecord)
    : [];
  const feedMessages = wakeContext?.messages ?? newRelayMessages;
  return {
    ...visibleState,
    relayMessages: feedMessages,
    newRelayMessages: feedMessages,
    relayFeed: {
      deliveredMessages: feedMessages.length,
      fromIndex: feedMessages.length > 0 ? relayIndex(feedMessages[0] ?? {}) : undefined,
      toIndex: feedMessages.length > 0 ? relayIndex(feedMessages.at(-1) ?? {}) : undefined,
      order: 'oldest-to-newest',
      wakeReason: wakeContext?.reason ?? 'turn',
      note: 'relayMessages is a live feed delta after this bot’s last delivered relay cursor. It is not memory and not full history; agents must store their own memory if they need it.',
    },
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (process.env.HARNESS_DEBUG_JSON === '1') console.warn(formatError(error));
    return null;
  }
}

function normalizeDecision(raw: unknown): ModelDecision {
  const record = isRecord(raw) ? raw : {};
  const actionRecord = isRecord(record.action) ? record.action : { type: 'pass' };
  const type = typeof actionRecord.type === 'string' ? actionRecord.type : 'pass';
  const reasoning =
    typeof record.reasoning === 'string'
      ? record.reasoning
      : typeof record.rationale === 'string'
        ? record.rationale
        : 'No explicit reasoning returned; defaulting to pass.';
  const publicMessage =
    typeof record.publicMessage === 'string'
      ? record.publicMessage
      : typeof record.message === 'string'
        ? record.message
        : '';
  return {
    reasoning,
    publicMessage,
    privateMessage: typeof record.privateMessage === 'string' ? record.privateMessage : '',
    dmRecipient: typeof record.dmRecipient === 'string' ? record.dmRecipient : undefined,
    action: { ...actionRecord, type },
  };
}

function toolNameFromDefinition(tool: unknown): string | null {
  if (!isRecord(tool)) return null;
  return typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : null;
}

function availableToolNames(tools: unknown[]): string[] {
  return tools.map(toolNameFromDefinition).filter((name): name is string => Boolean(name));
}

function selectNoArgTool(tools: unknown[]): string | null {
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = toolNameFromDefinition(tool);
    if (!name) continue;
    const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    if (required.length === 0) return name;
  }
  return null;
}

function selectDecisionAction(decision: ModelDecision, tools: unknown[]): ActionSelection | null {
  const action = isRecord(decision.action) ? decision.action : {};
  const requested = typeof action.type === 'string' ? action.type.trim() : '';
  if (!requested) return null;
  if (!availableToolNames(tools).includes(requested)) return null;
  const tool = tools.find((candidate) => toolNameFromDefinition(candidate) === requested);
  const { type: _type, ...rawArgs } = action;
  const args = repairArgsFromToolSchema(rawArgs, tool);
  return { toolName: requested, args };
}

function schemaProperties(tool: unknown): Record<string, unknown> {
  if (!isRecord(tool) || !isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties)) return {};
  return tool.inputSchema.properties;
}

function schemaRequired(tool: unknown): string[] {
  if (!isRecord(tool) || !isRecord(tool.inputSchema) || !Array.isArray(tool.inputSchema.required)) return [];
  return tool.inputSchema.required.filter((value): value is string => typeof value === 'string');
}

function schemaDefaultValue(schema: unknown): unknown {
  if (!isRecord(schema)) return undefined;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  return undefined;
}

function repairArgsFromToolSchema(rawArgs: Record<string, unknown>, tool: unknown): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };
  const argName = typeof args.argName === 'string' ? args.argName : '';
  if (argName && args.argValue !== undefined && args[argName] === undefined) args[argName] = args.argValue;
  delete args.argName;
  delete args.argValue;

  const properties = schemaProperties(tool);
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (isRecord(schema) && Array.isArray(schema.enum) && value !== undefined && !schema.enum.includes(value)) {
      const fallback = schemaDefaultValue(schema);
      if (fallback !== undefined) args[key] = fallback;
    }
  }
  for (const key of schemaRequired(tool)) {
    if (args[key] !== undefined) continue;
    const fallback = schemaDefaultValue(properties[key]);
    if (fallback !== undefined) args[key] = fallback;
  }
  return args;
}

function actionRejectionState(
  visibleState: Record<string, unknown>,
  decision: ModelDecision,
  error: unknown,
  tools: unknown[],
): Record<string, unknown> {
  return {
    ...visibleState,
    harnessPreviousActionRejected: true,
    harnessRejectedAction: decision.action,
    harnessActionError: formatError(error).slice(0, 1200),
    harnessAvailableToolNames: availableToolNames(tools),
    harnessCorrectionInstruction:
      'Choose a corrected action using only currentPhase.tools / Available tools. Do not retry the rejected action unless you can change its arguments to satisfy the runtime rules.',
  };
}

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted' as const;
  readonly model: string;

  constructor(readonly config: ProviderConfig = defaultProviderConfig()) {
    this.model = config.model;
  }

  async decide(input: ProviderInput): Promise<ModelDecision> {
    if (input.mode === 'communication') {
      return {
        reasoning: `${input.bot.name}: ${input.bot.persona.title}; scripted communication wake for round ${input.round}.`,
        publicMessage: input.bot.persona.publicStyle,
        privateMessage: input.bot.persona.privateStyle,
        dmRecipient: input.wakeContext?.privateReplyTo,
        action: {},
      };
    }
    const noArgTool = selectNoArgTool(input.tools);
    return {
      reasoning: noArgTool
        ? `${input.bot.name}: ${input.bot.persona.title}; scripted baseline selected runtime-advertised no-argument tool ${noArgTool}.`
        : `${input.bot.name}: ${input.bot.persona.title}; scripted baseline cannot synthesize arguments for available runtime tools. Configure a model provider for games/phases that require arguments.`,
      publicMessage: input.bot.persona.publicStyle,
      privateMessage: input.bot.persona.privateStyle,
      dmRecipient: undefined,
      action: noArgTool ? { type: noArgTool } : {},
    };
  }
}

function providerPromptMessages(input: ProviderInput): ChatMessage[] {
  const communicationOnly = input.mode === 'communication';
  const modeInstruction = communicationOnly
    ? 'COMMUNICATION-ONLY WAKE: You are responding to new public chat, DM, or relay updates outside your action turn. Your action field will be ignored. If the wake context includes privateReplyTo, normally answer with privateMessage addressed to privateReplyTo. Use an empty string only when you intentionally decline to respond.'
    : 'ACTION TURN: Choose one legal game action. You may also send publicMessage/privateMessage, or use empty strings if silence is strategically better.';
  const wakeContextText = input.wakeContext ? `\nWake context:\n${jsonPrompt(input.wakeContext)}` : '';
  const promptVisibleState = relayFeedStateForModelPrompt(input.visibleState, input.wakeContext);
  return [
    {
      role: 'system',
      content: `You are an autonomous game-playing agent in a Coordination Games runtime.

${modeInstruction}

Persona for this agent:
${input.bot.persona.title}
${input.bot.persona.instruction}

Return ONLY compact JSON with this exact shape:
{"reasoning":"private decision trace, not chat","publicMessage":"short natural public negotiation message to all players, or empty string","privateMessage":"short direct message to one other player, or empty string","dmRecipient":"exact player name/handle you want to DM (optional)","action":{"type":"<available tool name>","argName":"arg value from the tool schema"}}

Rules:
1. Available tools is the authoritative live tool list for this player and phase. Choose action.type from Available tools[*].name exactly.
2. Use each selected tool's inputSchema exactly. Include required arguments and do not include extra fields.
3. If Available tools is empty, return action as an empty object and use messages only.
4. Infer legal argument values from Visible state, the game guide/status embedded there, and tool descriptions. If the runtime rejected your previous action, correct the arguments instead of repeating it.
5. Prefer simple legal actions over complex invalid ones.
6. publicMessage/privateMessage must read like chat between agents, not action justifications.
7. Do not include provider reasoning in chat messages.
8. READ relayMessages carefully. The handles map converts UUIDs to player names.
9. Treat trustCards as compact viewer-visible evidence summaries with caveats, not as hidden knowledge or final reputation scores.
10. dmRecipient must use the exact player name/handle from the visible state.
`,
    },
    {
      role: 'user',
      content: `Agent: ${input.bot.name}
Persona: ${input.bot.persona.title}
Persona instructions: ${input.bot.persona.instruction}
Round: ${input.round}
Mode: ${input.mode}
Available tools:
${jsonPrompt(input.tools)}
Visible state:
${jsonPrompt(promptVisibleState)}${wakeContextText}

IMPORTANT: relayMessages and newRelayMessages are only the latest delivered feed after this bot's last cursor, not full history. Respond directly to the latest delivered messages when useful.

${modeInstruction}

publicMessage goes to all players. privateMessage plus dmRecipient goes to one specific player.`,
    },
  ];
}

function openCodeGoModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith('opencode-go/') ? trimmed.slice('opencode-go/'.length) : trimmed;
}

class OpenAICompatibleProvider implements ModelProvider {
  private readonly usageStats: ProviderUsage = emptyUsage();
  readonly name: 'openai-compatible' | 'minimax';
  readonly model: string;

  constructor(
    readonly config: ProviderConfig,
    private readonly apiKey: string,
  ) {
    if (config.provider === 'scripted' || config.provider === 'opencode-go') {
      throw new Error('OpenAICompatibleProvider requires minimax or openai-compatible config');
    }
    this.name = config.provider;
    this.model = config.model;
  }

  usage(): ProviderUsage {
    return { ...this.usageStats };
  }

  private recordUsage(body: unknown): void {
    if (!isRecord(body) || !isRecord(body.usage)) return;
    const promptTokens = getNumber(body.usage.prompt_tokens, 0);
    const completionTokens = getNumber(body.usage.completion_tokens, 0);
    const totalTokens = getNumber(body.usage.total_tokens, promptTokens + completionTokens);
    this.usageStats.requests += 1;
    this.usageStats.promptTokens += promptTokens;
    this.usageStats.completionTokens += completionTokens;
    this.usageStats.totalTokens += totalTokens;
    this.usageStats.estimatedCostUsd += estimateCostUsd(promptTokens, completionTokens);
  }

  async decide(input: ProviderInput): Promise<ModelDecision> {
    const messages = providerPromptMessages(input);
    const requestBody: Record<string, unknown> = {
      model: this.model,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      max_completion_tokens: this.config.maxCompletionTokens,
      reasoning_split: this.config.reasoningSplit,
      messages,
    };
    if (this.config.reasoningEffort) requestBody.reasoning_effort = this.config.reasoningEffort;
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `${this.name} ${this.model} HTTP ${response.status} for ${input.bot.name} ${input.mode} round ${input.round}: ${bodyText.slice(0, 500)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      throw new Error(
        `${this.name} ${this.model} returned invalid JSON for ${input.bot.name} ${input.mode} round ${input.round}: ${formatError(error)}; body=${bodyText.slice(0, 500)}`,
      );
    }
    this.recordUsage(body);
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    const messageRecord = isRecord(message) ? message : {};
    const content = typeof messageRecord.content === 'string' ? messageRecord.content : '';
    const decision = normalizeDecision(extractJsonObject(content));
    const reasoningDetails = Array.isArray(messageRecord.reasoning_details)
      ? messageRecord.reasoning_details
          .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    return {
      ...decision,
      reasoning: reasoningDetails
        ? `${decision.reasoning}\n\n[provider reasoning summary]\n${reasoningDetails}`
        : decision.reasoning,
    };
  }
}

class OpenCodeGoProvider implements ModelProvider {
  private readonly usageStats: ProviderUsage = emptyUsage();
  private sessionId: string | undefined;
  readonly name = 'opencode-go' as const;
  readonly model: string;

  constructor(readonly config: ProviderConfig) {
    if (config.provider !== 'opencode-go') throw new Error('OpenCodeGoProvider requires opencode-go config');
    this.model = config.model;
  }

  usage(): ProviderUsage {
    return { ...this.usageStats };
  }

  private baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (password) {
      const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    return headers;
  }

  private async parseJsonResponse(response: Response, context: string): Promise<unknown> {
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`${context} HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
    }
    try {
      return JSON.parse(bodyText);
    } catch (error) {
      throw new Error(`${context} returned invalid JSON: ${formatError(error)}; body=${bodyText.slice(0, 500)}`);
    }
  }

  private async ensureSessionId(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const response = await fetch(`${this.baseUrl()}/session`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ title: `Coordination Games Harness ${RUN_ID}` }),
    });
    const body = await this.parseJsonResponse(response, `${this.name} create session`);
    if (!isRecord(body) || typeof body.id !== 'string' || !body.id) {
      throw new Error(`${this.name} create session response did not include a session id`);
    }
    this.sessionId = body.id;
    return body.id;
  }

  async decide(input: ProviderInput): Promise<ModelDecision> {
    const sessionId = await this.ensureSessionId();
    const messages = providerPromptMessages(input);
    const systemMessage = messages.find((message) => message.role === 'system')?.content;
    const userMessage = messages.find((message) => message.role === 'user')?.content ?? '';
    const response = await fetch(`${this.baseUrl()}/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: { providerID: 'opencode-go', modelID: openCodeGoModelId(this.model) },
        agent: OPENCODE_GO_AGENT,
        noReply: false,
        system: systemMessage,
        parts: [{ type: 'text', text: userMessage }],
      }),
    });
    const body = await this.parseJsonResponse(
      response,
      `${this.name} ${this.model} for ${input.bot.name} ${input.mode} round ${input.round}`,
    );
    const parts = isRecord(body) && Array.isArray(body.parts) ? body.parts : [];
    const content = parts
      .map((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
    if (!content.trim()) {
      throw new Error(`${this.name} ${this.model} returned no text parts for ${input.bot.name} ${input.mode} round ${input.round}`);
    }
    this.usageStats.requests += 1;
    return normalizeDecision(extractJsonObject(content));
  }
}

function apiKeyForConfig(config: ProviderConfig): string {
  const keyEnv = resolvedApiKeyEnvName(config);
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`${keyEnv} is required for provider ${config.provider}`);
  }
  return apiKey;
}

function createProvider(config: ProviderConfig): ModelProvider {
  if (config.provider === 'scripted') return new ScriptedProvider(config);
  const keyEnv = resolvedApiKeyEnvName(config);
  validateProviderBaseUrl(config, keyEnv);
  if (config.provider === 'opencode-go') return new OpenCodeGoProvider(config);
  return new OpenAICompatibleProvider(config, apiKeyForConfig(config));
}

async function createBots(botConfigs: BotRuntimeConfig[]): Promise<HarnessBot[]> {
  const bots: HarnessBot[] = [];
  for (const botConfig of botConfigs) {
    const wallet = Wallet.createRandom();
    const name = APPEND_ADDRESS_SUFFIX
      ? `${botConfig.name} ${wallet.address.slice(2, 10)}`
      : botConfig.name;
    const auth = await authenticate(SERVER, wallet.privateKey, name);
    bots.push({
      name,
      token: auth.token,
      playerId: auth.playerId,
      privateKey: wallet.privateKey,
      persona: botConfig.persona,
      providerConfig: botConfig.providerConfig,
    });
  }
  return bots;
}

function createProvidersByBot(bots: HarnessBot[]): Map<string, ModelProvider> {
  return new Map(bots.map((bot) => [bot.playerId, createProvider(bot.providerConfig)]));
}

function providerForBot(providers: Map<string, ModelProvider>, bot: HarnessBot): ModelProvider {
  const provider = providers.get(bot.playerId);
  if (!provider) throw new Error(`No provider configured for ${bot.name}`);
  return provider;
}

async function inspect(sessionId: string): Promise<Record<string, unknown>> {
  const result = await fetchJsonWithRetry(`${SERVER}/api/admin/session/${sessionId}/inspect`, {
    headers: { 'X-Admin-Token': INSPECTOR_TOKEN },
  }, `GET inspect ${sessionId}`);
  if (!result.ok || !isRecord(result.json)) {
    throw new Error(`inspect failed for ${sessionId}: HTTP ${result.status}: ${JSON.stringify(result.json).slice(0, 500)}`);
  }
  return result.json;
}

function relayFor(decision: ModelDecision, provider: ModelProvider): Record<string, unknown> {
  return {
    type: 'reasoning',
    pluginId: 'reasoning',
    scope: 'all',
    data: { body: decision.reasoning, stage: 'decision', tags: { provider: provider.name, model: provider.model, runId: RUN_ID } },
  };
}

function chatRelayFor(
  decision: ModelDecision,
  provider: ModelProvider,
  scope: string | { kind: 'dm'; recipientHandle: string } = 'all',
  message = decision.publicMessage,
): Record<string, unknown> {
  const resolvedScope = typeof scope === 'string' && scope !== 'all' ? { kind: 'dm', recipientHandle: scope } : scope;
  return {
    type: 'messaging',
    pluginId: 'basic-chat',
    scope: resolvedScope,
    data: { body: message, tags: { provider: provider.name, model: provider.model, runId: RUN_ID, source: 'model-harness' } },
  };
}

function resolveBotTarget(bots: HarnessBot[], activeBot: HarnessBot, requestedRecipient: string | undefined): HarnessBot | undefined {
  const trimmedRecipient = requestedRecipient?.trim();
  if (!trimmedRecipient || trimmedRecipient === 'system') return undefined;
  const target = bots.find(
    (bot) =>
      bot.name === trimmedRecipient ||
      bot.playerId === trimmedRecipient ||
      bot.name.includes(trimmedRecipient) ||
      bot.playerId.includes(trimmedRecipient),
  );
  return target && target.playerId !== activeBot.playerId ? target : undefined;
}

function rotateBots(bots: HarnessBot[], offset: number): HarnessBot[] {
  if (bots.length === 0) return [];
  const pivot = ((offset % bots.length) + bots.length) % bots.length;
  return [...bots.slice(pivot), ...bots.slice(0, pivot)];
}

async function callTool(bot: HarnessBot, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  return api(SERVER, '/api/player/tool', { method: 'POST', token: bot.token, body: { toolName, args } });
}

function gameStateFromInspect(inspectRecord: Record<string, unknown>): Record<string, unknown> {
  const gameInspect = isRecord(inspectRecord.gameInspect) ? inspectRecord.gameInspect : {};
  return isRecord(gameInspect.gameState) ? gameInspect.gameState : {};
}

function currentPlayerIdFromGameState(gameState: Record<string, unknown>): string | undefined {
  const players = Array.isArray(gameState.players) ? gameState.players : [];
  const index = typeof gameState.currentPlayerIndex === 'number' ? gameState.currentPlayerIndex : -1;
  const currentPlayer = players[index];
  if (!isRecord(currentPlayer)) return undefined;
  return typeof currentPlayer.id === 'string' ? currentPlayer.id : undefined;
}

function recordedActionFor(gameState: Record<string, unknown>, playerId: string): Record<string, unknown> | undefined {
  const submittedActions = isRecord(gameState.submittedActions) ? gameState.submittedActions : {};
  const recorded = submittedActions[playerId];
  return isRecord(recorded) ? recorded : undefined;
}

async function actionRecordedOrTurnAdvanced(gameId: string, playerId: string): Promise<boolean> {
  const latestInspect = await inspect(gameId);
  const latestGameState = gameStateFromInspect(latestInspect);
  if (recordedActionFor(latestGameState, playerId)) return true;
  const currentPlayerId = currentPlayerIdFromGameState(latestGameState);
  return currentPlayerId !== undefined && currentPlayerId !== playerId;
}

function isModelTimeoutError(error: unknown): boolean {
  const message = formatError(error);
  return /timed out after \d+ms/i.test(message);
}

async function waitForRuntimeAdvanceAfterModelFailure(
  gameId: string,
  bot: HarnessBot,
  provider: ModelProvider,
  round: number,
  error: unknown,
  reason: 'model_timeout' | 'invalid_model_action',
): Promise<boolean> {
  await appendJsonlArtifact('errors.jsonl', {
    type: `${reason}_yielded_to_runtime`,
    bot: bot.name,
    playerId: bot.playerId,
    provider: provider.name,
    model: provider.model,
    round,
    waitMs: RUNTIME_ADVANCE_WAIT_MS,
    error: formatError(error),
  });
  console.log(`  ${bot.name}: ${reason === 'model_timeout' ? 'model timed out' : 'model did not produce a valid runtime action'}; submitting no action and waiting for runtime timeout/advance`);

  const deadline = Date.now() + RUNTIME_ADVANCE_WAIT_MS;
  while (Date.now() <= deadline) {
    if (await actionRecordedOrTurnAdvanced(gameId, bot.playerId)) {
      await appendJsonlArtifact('turns.jsonl', {
        type: `runtime_advanced_after_${reason}`,
        bot: bot.name,
        playerId: bot.playerId,
        persona: bot.persona.id,
        provider: provider.name,
        model: provider.model,
        round,
      });
      console.log(`  ${bot.name}: runtime advanced after ${reason}`);
      return true;
    }
    const latestInspect = await inspect(gameId);
    const latestGameState = gameStateFromInspect(latestInspect);
    const phase = typeof latestGameState.phase === 'string' ? latestGameState.phase : '';
    if (phase === 'finished') {
      await appendJsonlArtifact('turns.jsonl', {
        type: `runtime_finished_after_${reason}`,
        bot: bot.name,
        playerId: bot.playerId,
        persona: bot.persona.id,
        provider: provider.name,
        model: provider.model,
        round,
      });
      console.log(`  ${bot.name}: runtime finished after ${reason}`);
      return true;
    }
    await sleep(1000);
  }
  await appendJsonlArtifact('errors.jsonl', {
    type: `runtime_did_not_advance_after_${reason}`,
    bot: bot.name,
    playerId: bot.playerId,
    provider: provider.name,
    model: provider.model,
    round,
    waitMs: RUNTIME_ADVANCE_WAIT_MS,
    error: formatError(error),
  });
  return false;
}

function relayIndex(message: Record<string, unknown>): number {
  return typeof message.index === 'number' && Number.isFinite(message.index) ? message.index : -1;
}

function maxRelayIndex(messages: Record<string, unknown>[]): number {
  return messages.reduce((max, message) => Math.max(max, relayIndex(message)), -1);
}

function relaySender(message: Record<string, unknown>): string {
  return typeof message.sender === 'string' ? message.sender : '';
}

function isOwnRelay(message: Record<string, unknown>, bot: HarnessBot): boolean {
  const sender = relaySender(message);
  return sender === bot.name || sender === bot.playerId;
}

function shouldWakeForRelay(message: Record<string, unknown>, bot: HarnessBot): boolean {
  if (isOwnRelay(message, bot)) return false;
  const type = typeof message.type === 'string' ? message.type : '';
  return type === 'messaging' || type === 'reasoning';
}

function relayScopeKind(message: Record<string, unknown>): string {
  const scope = isRecord(message.scope) ? message.scope : {};
  return typeof scope.kind === 'string' ? scope.kind : '';
}

function relayBody(message: Record<string, unknown>): string {
  const data = isRecord(message.data) ? message.data : {};
  if (typeof data.body === 'string') return data.body;
  if (typeof data.text === 'string') return data.text;
  return '';
}

function buildWakeContext(bot: HarnessBot, bots: HarnessBot[], newWakeRelays: Record<string, unknown>[]): WakeContext {
  const privateMessages = newWakeRelays.filter((message) => message.type === 'messaging' && relayScopeKind(message) === 'dm');
  const publicMessages = newWakeRelays.filter((message) => message.type === 'messaging' && relayScopeKind(message) !== 'dm');
  const latestPrivate = privateMessages
    .slice()
    .reverse()
    .find((message) => resolveBotTarget(bots, bot, relaySender(message)) !== undefined);
  const privateReplyTo = latestPrivate ? relaySender(latestPrivate) : undefined;
  const reason = latestPrivate ? (publicMessages.length > 0 ? 'mixed' : 'private') : publicMessages.length > 0 ? 'public' : 'mixed';
  const latestSender = privateReplyTo ?? relaySender(newWakeRelays.at(-1) ?? {});
  const latestBody = relayBody(latestPrivate ?? newWakeRelays.at(-1) ?? {}).slice(0, 240);
  return {
    reason,
    privateReplyTo,
    messages: newWakeRelays,
    summary: latestPrivate
      ? `${bot.name} received a private DM from ${latestSender}: ${latestBody}`
      : `${bot.name} received ${newWakeRelays.length} new visible relay message(s).`,
  };
}

function extractTools(visibleState: Record<string, unknown>): unknown[] {
  const currentPhase = isRecord(visibleState.currentPhase) ? visibleState.currentPhase : {};
  return Array.isArray(currentPhase.tools) ? currentPhase.tools : [];
}

function relayCursorFromEnvelope(stateEnvelope: Record<string, unknown>, fallback: number): number {
  const meta = isRecord(stateEnvelope.meta) ? stateEnvelope.meta : {};
  return typeof meta.sinceIdx === 'number' && Number.isFinite(meta.sinceIdx) ? meta.sinceIdx : fallback;
}

async function fetchBotContext(bot: HarnessBot, sinceIdx?: number): Promise<BotContext> {
  const statePath = sinceIdx === undefined ? '/api/player/state' : `/api/player/state?sinceIdx=${sinceIdx}`;
  const stateEnvelope = asRecord(await api(SERVER, statePath, { token: bot.token }), 'state');
  const rawState = isRecord(stateEnvelope.state) ? stateEnvelope.state : stateEnvelope;
  const envelopeCurrentPhase = isRecord(stateEnvelope.currentPhase) ? stateEnvelope.currentPhase : undefined;
  const currentPhase = envelopeCurrentPhase ?? (isRecord(rawState.currentPhase) ? rawState.currentPhase : undefined);
  const handles = isRecord(stateEnvelope.meta) && isRecord(stateEnvelope.meta.handles) ? stateEnvelope.meta.handles : {};
  const rawRelay: unknown[] = Array.isArray(rawState.relayMessages) ? rawState.relayMessages : [];
  const enrichedRelay = rawRelay.map((rawMessage): Record<string, unknown> => {
    if (!isRecord(rawMessage)) return {};
    const sender = typeof rawMessage.sender === 'string' ? rawMessage.sender : '';
    const resolved = typeof handles[sender] === 'string' ? handles[sender] : sender;
    const scope = isRecord(rawMessage.scope) ? { ...rawMessage.scope } : rawMessage.scope;
    if (isRecord(scope) && typeof scope.recipientHandle === 'string' && typeof handles[scope.recipientHandle] === 'string') {
      scope.recipientHandle = handles[scope.recipientHandle];
    }
    return { ...rawMessage, sender: resolved, scope };
  });
  const visibleState: Record<string, unknown> = {
    ...rawState,
    ...(currentPhase ? { currentPhase } : {}),
    ...(typeof stateEnvelope.gameOver === 'boolean' ? { gameOver: stateEnvelope.gameOver } : {}),
    handles,
    relayMessages: enrichedRelay,
  };
  return {
    visibleState,
    tools: extractTools(visibleState),
    relayMessages: enrichedRelay,
    nextRelayCursor: relayCursorFromEnvelope(stateEnvelope, maxRelayIndex(enrichedRelay) + 1),
  };
}

async function publishDecisionMessages(
  bot: HarnessBot,
  bots: HarnessBot[],
  decision: ModelDecision,
  provider: ModelProvider,
  fallbackDmRecipient: string | undefined,
): Promise<void> {
  if (decision.reasoning.trim()) await callTool(bot, 'plugin_relay', { relay: relayFor(decision, provider) });
  if (decision.publicMessage.trim()) await callTool(bot, 'plugin_relay', { relay: chatRelayFor(decision, provider) });
  if (decision.privateMessage.trim()) {
    const dmTarget = resolveBotTarget(bots, bot, decision.dmRecipient ?? fallbackDmRecipient);
    if (dmTarget) {
      await callTool(bot, 'plugin_relay', { relay: chatRelayFor(decision, provider, dmTarget.name, decision.privateMessage) });
      console.log(`  ${bot.name}: DM to ${dmTarget.name} (playerId=${dmTarget.playerId})`);
    } else {
      console.log(`  ${bot.name}: no valid DM recipient found`);
    }
  }
}

async function runCommunicationSweeps(
  bots: HarnessBot[],
  providers: Map<string, ModelProvider>,
  round: number,
  nextRelayCursorByBot: Map<string, number>,
): Promise<void> {
  const budgetProviders = [...providers.values()];
  for (let sweep = 0; sweep < COMMUNICATION_SWEEPS; sweep++) {
    const orderedBots = rotateBots(bots, round + sweep);
    const sweepCursors = new Map(nextRelayCursorByBot);
    const pendingDecisions: Array<{ bot: HarnessBot; decision: ModelDecision; privateReplyTo: string | undefined }> = [];
    for (const bot of orderedBots) {
      const previousCursor = sweepCursors.get(bot.playerId) ?? 0;
      const context = await fetchBotContext(bot, previousCursor);
      const newWakeRelays = context.relayMessages.filter((message) => shouldWakeForRelay(message, bot));
      nextRelayCursorByBot.set(bot.playerId, context.nextRelayCursor);
      if (newWakeRelays.length === 0) continue;

      const wakeContext = buildWakeContext(bot, bots, newWakeRelays);
      console.log(`  ${bot.name}: communication wake relays=${newWakeRelays.length} reason=${wakeContext.reason} sweep=${sweep + 1}`);
      const communicationState = {
        ...context.visibleState,
        relayMessages: newWakeRelays,
        newRelayMessages: newWakeRelays,
        harnessWakeReason: 'new-relay-messages',
      };
      let decision: ModelDecision | undefined;
      const provider = providerForBot(providers, bot);
      try {
        decision = await decideWithRetries(
          provider,
          { bot, visibleState: communicationState, tools: context.tools, round, mode: 'communication', wakeContext },
          {
            type: 'communication',
            sweep: sweep + 1,
            relayCursor: `${previousCursor}->${context.nextRelayCursor}`,
          },
          budgetProviders,
        );
      } catch (error) {
        if (isModelTimeoutError(error)) {
          await appendJsonlArtifact('errors.jsonl', {
            type: 'communication_model_timeout_skipped',
            bot: bot.name,
            playerId: bot.playerId,
            provider: provider.name,
            model: provider.model,
            round,
            sweep: sweep + 1,
            relayCursor: `${previousCursor}->${context.nextRelayCursor}`,
            error: formatError(error),
          });
          console.log(`  ${bot.name}: communication model timeout; skipping communication message`);
          continue;
        }
        throw new Error(
          `communication decision failed for ${bot.name} round=${round} sweep=${sweep + 1} relayCursor=${previousCursor}->${context.nextRelayCursor}: ${formatError(error)}`,
        );
      }
      pendingDecisions.push({ bot, decision, privateReplyTo: wakeContext.privateReplyTo });
    }
    for (const { bot, decision, privateReplyTo } of pendingDecisions) {
      const provider = providerForBot(providers, bot);
      try {
        await publishDecisionMessages(bot, bots, decision, provider, privateReplyTo);
      } catch (error) {
        throw new Error(`communication publish failed for ${bot.name} round=${round} sweep=${sweep + 1}: ${formatError(error)}`);
      }
    }
    if (pendingDecisions.length === 0) break;
  }
}

async function main(): Promise<void> {
  await ensureRunDir();
  const botConfigs = await loadBotRuntimeConfigs();
  console.log(`model-harness run=${RUN_ID} defaultProvider=${PROVIDER_NAME} defaultModel=${MODEL}`);
  console.log(`server=${SERVER} game=${GAME_TYPE} bots=${BOT_COUNT}`);
  if (ARTIFACTS_ENABLED) console.log(`artifacts=${RUN_DIR}`);
  await writeJsonArtifact('run.config.json', {
    schema: 1,
    runId: RUN_ID,
    server: SERVER,
    webBaseUrl: WEB_BASE_URL,
    gameType: GAME_TYPE,
    botCount: BOT_COUNT,
    configuredBotCount: botConfigs.length,
    teamSize: TEAM_SIZE,
    maxRounds: MAX_ROUNDS,
    communicationSweeps: COMMUNICATION_SWEEPS,
    provider: normalizeProviderName(PROVIDER_NAME),
    model: MODEL,
    providerDefaults: publicProviderConfig(defaultProviderConfig()),
    botProviderConfigs: botConfigs.map((botConfig) => ({
      name: botConfig.name,
      persona: botConfig.persona.id,
      providerConfig: publicProviderConfig(botConfig.providerConfig),
    })),
    botConfigPath: BOT_CONFIG_PATH,
    appendAddressSuffix: APPEND_ADDRESS_SUFFIX,
    modelCallTimeoutMs: MODEL_CALL_TIMEOUT_MS,
    modelCallRetries: MODEL_CALL_RETRIES,
    runtimeAdvanceWaitMs: RUNTIME_ADVANCE_WAIT_MS,
    actionCorrectionAttempts: ACTION_CORRECTION_ATTEMPTS,
    gameApi: gameApiRetryDefaults(),
    openCodeGoAgent: OPENCODE_GO_AGENT,
    maxCostUsd: MAX_COST_USD > 0 ? MAX_COST_USD : undefined,
    promptUsdPer1M: PROMPT_USD_PER_1M > 0 ? PROMPT_USD_PER_1M : undefined,
    completionUsdPer1M: COMPLETION_USD_PER_1M > 0 ? COMPLETION_USD_PER_1M : undefined,
    note: 'No provider API keys, inspector tokens, bot bearer tokens, or wallet private keys are written to artifacts.',
  });

  const bots = await createBots(botConfigs);
  const providers = createProvidersByBot(bots);
  const budgetProviders = [...providers.values()];
  const firstBot = bots[0];
  if (!firstBot) throw new Error('At least one bot is required to create a lobby');
  const lobby = asRecord(
    await api(SERVER, '/api/lobbies/create', { method: 'POST', token: firstBot.token, body: { gameType: GAME_TYPE, teamSize: TEAM_SIZE } }),
    'create lobby',
  );
  const lobbyId = String(lobby.lobbyId);
  console.log(`lobby=${lobbyId}`);
  await appendJsonlArtifact('games.jsonl', {
    type: 'lobby_created',
    lobbyId,
    gameType: GAME_TYPE,
    teamSize: TEAM_SIZE,
    bots: bots.map((bot) => ({
      name: bot.name,
      playerId: bot.playerId,
      persona: bot.persona.id,
      providerConfig: publicProviderConfig(bot.providerConfig),
    })),
  });

  for (const bot of bots) {
    const joined = asRecord(
      await api(SERVER, '/api/player/lobby/join', { method: 'POST', token: bot.token, body: { lobbyId } }),
      'join lobby',
    );
    console.log(`joined ${bot.name} persona="${bot.persona.title}" phase=${String(joined.phase ?? 'unknown')}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const lobbyInspect = await inspect(lobbyId);
  const gameId = typeof lobbyInspect.gameId === 'string' ? lobbyInspect.gameId : null;
  if (!gameId) throw new Error(`Lobby did not start a game: ${JSON.stringify(lobbyInspect.lobby)}`);
  console.log(`game=${gameId}`);
  await appendJsonlArtifact('games.jsonl', { type: 'game_started', lobbyId, gameId });

  const nextRelayCursorByBot = new Map<string, number>();
  for (const bot of bots) {
    const context = await fetchBotContext(bot);
    nextRelayCursorByBot.set(bot.playerId, context.nextRelayCursor);
  }

  if (MAX_ROUNDS <= 0) {
    console.log(`harness gameplay round limit is ${MAX_ROUNDS}; skipping model decision loop`);
  }
  const processedGameplayRounds = new Set<number>();
  const maxHarnessCycles = Math.max(MAX_ROUNDS * 3 + bots.length, MAX_ROUNDS + bots.length + 4);
  for (let roundLoop = 0; MAX_ROUNDS > 0 && roundLoop < maxHarnessCycles; roundLoop++) {
    const gameInspect = await inspect(gameId);
    const diagnostics = isRecord(gameInspect.gameInspect) ? gameInspect.gameInspect : {};
    const gameState = isRecord(diagnostics.gameState) ? diagnostics.gameState : {};
    const phase = typeof gameState.phase === 'string' ? gameState.phase : 'unknown';
    const round = getNumber(gameState.round, roundLoop + 1);
    if (phase === 'finished') break;
    const countsTowardRoundBudget = phase !== 'waiting' && phase !== 'lobby' && phase !== 'unknown';
    if (countsTowardRoundBudget && !processedGameplayRounds.has(round) && processedGameplayRounds.size >= MAX_ROUNDS) {
      console.log(`reached harness gameplay round limit (${MAX_ROUNDS}); stopping at round=${round} phase=${phase}`);
      break;
    }
    if (countsTowardRoundBudget) processedGameplayRounds.add(round);
    console.log(`round=${round} phase=${phase}`);

    const actedThisRound = new Set<string>();
    let maxTurnsPerRound = bots.length * 2;
    while (actedThisRound.size < bots.length && maxTurnsPerRound-- > 0) {
      const turnInspect = await inspect(gameId);
      const turnDiagnostics = isRecord(turnInspect.gameInspect) ? turnInspect.gameInspect : {};
      const turnState = isRecord(turnDiagnostics.gameState) ? turnDiagnostics.gameState : {};
      const currentPlayerIndex = typeof turnState.currentPlayerIndex === 'number' ? turnState.currentPlayerIndex : 0;
      const players = Array.isArray(turnState.players) ? turnState.players : [];
      const currentPlayerObj = isRecord(players[currentPlayerIndex]) ? players[currentPlayerIndex] : null;
      const currentPlayerId = typeof currentPlayerObj?.id === 'string' ? currentPlayerObj.id : null;
      if (!currentPlayerId) {
        console.log('  cannot determine current player, breaking');
        break;
      }
      if (actedThisRound.has(currentPlayerId)) {
        console.log(`  ${currentPlayerId} already acted this round, breaking`);
        break;
      }
      const activeBot = bots.find((bot) => bot.playerId === currentPlayerId);
      if (!activeBot) {
        console.log(`  no bot found for player ${currentPlayerId}, breaking`);
        break;
      }

      const previousCursor = nextRelayCursorByBot.get(activeBot.playerId) ?? 0;
      const context = await fetchBotContext(activeBot, previousCursor);
      const turnFeedRelays = context.relayMessages.filter((message) => shouldWakeForRelay(message, activeBot));
      const visibleState: Record<string, unknown> = {
        ...context.visibleState,
        relayMessages: turnFeedRelays,
        newRelayMessages: turnFeedRelays,
        harnessWakeReason: 'action-turn-feed',
      };
      nextRelayCursorByBot.set(activeBot.playerId, context.nextRelayCursor);
      console.log(`  ${activeBot.name}: relayFeed=${turnFeedRelays.length} totalVisibleRelay=${context.relayMessages.length}`);
      const turnWakeContext = buildWakeContext(activeBot, bots, turnFeedRelays);
      const provider = providerForBot(providers, activeBot);
      let decision: ModelDecision | undefined;
      let yieldedToRuntime = false;
      try {
        decision = await decideWithRetries(
          provider,
          {
            bot: activeBot,
            visibleState,
            tools: context.tools,
            round,
            mode: 'turn',
            wakeContext: {
              reason: 'turn',
              summary: `${activeBot.name} is taking an action turn with ${turnFeedRelays.length} new relay feed item(s) after its last delivered relay cursor.`,
              privateReplyTo: turnWakeContext.privateReplyTo,
              messages: turnFeedRelays,
            },
          },
          { type: 'turn', relayCursor: `${previousCursor}->${context.nextRelayCursor}` },
          budgetProviders,
        );
      } catch (error) {
        if (isModelTimeoutError(error)) {
          const advanced = await waitForRuntimeAdvanceAfterModelFailure(gameId, activeBot, provider, round, error, 'model_timeout');
          if (advanced) {
            yieldedToRuntime = true;
          } else {
            throw error;
          }
        }
        if (!yieldedToRuntime) throw error;
      }
      if (yieldedToRuntime) break;
      if (!decision) throw new Error(`${activeBot.name}: model decision missing without runtime advancement`);
      if (visibleState.isYourTurn === true) {
        let actionContext = context;
        let lastActionError: unknown;
        for (let actionAttempt = 1; actionAttempt <= ACTION_CORRECTION_ATTEMPTS; actionAttempt++) {
          const selection = selectDecisionAction(decision, actionContext.tools);
          if (!selection) {
            lastActionError = new Error(
              `Provider selected unavailable action ${JSON.stringify(decision.action)}; valid tools now: ${availableToolNames(actionContext.tools).join(', ') || '(none)'}`,
            );
          } else {
            try {
              console.log(`  ${activeBot.name}: attempting ${selection.toolName} with args ${JSON.stringify(selection.args)}`);
              await callTool(activeBot, selection.toolName, selection.args);
              console.log(`  ${activeBot.name}: ${selection.toolName}`);
              await publishDecisionMessages(activeBot, bots, decision, provider, turnWakeContext.privateReplyTo);
              await appendJsonlArtifact('turns.jsonl', {
                type: 'action_submitted',
                bot: activeBot.name,
                playerId: activeBot.playerId,
                persona: activeBot.persona.id,
                provider: provider.name,
                model: provider.model,
                round,
                actionAttempt,
                toolName: selection.toolName,
                args: selection.args,
              });
              actedThisRound.add(currentPlayerId);
              lastActionError = undefined;
              break;
            } catch (error) {
              lastActionError = error;
              if (await actionRecordedOrTurnAdvanced(gameId, currentPlayerId)) {
                await publishDecisionMessages(activeBot, bots, decision, provider, turnWakeContext.privateReplyTo);
                await appendJsonlArtifact('turns.jsonl', {
                  type: 'action_observed_success_after_error',
                  bot: activeBot.name,
                  playerId: activeBot.playerId,
                  persona: activeBot.persona.id,
                  provider: provider.name,
                  model: provider.model,
                  round,
                  actionAttempt,
                  toolName: selection.toolName,
                  args: selection.args,
                  error: formatError(error),
                });
                console.log(`  ${activeBot.name}: ${selection.toolName} reported failure, but inspect shows action recorded or turn advanced`);
                actedThisRound.add(currentPlayerId);
                lastActionError = undefined;
                break;
              }
            }
          }

          if (actionAttempt >= ACTION_CORRECTION_ATTEMPTS) break;
          console.log(`  ${activeBot.name}: action rejected, requesting corrected runtime-driven decision (${formatError(lastActionError).slice(0, 180)})`);
          const correctionContext = await fetchBotContext(activeBot, nextRelayCursorByBot.get(activeBot.playerId) ?? previousCursor);
          nextRelayCursorByBot.set(activeBot.playerId, correctionContext.nextRelayCursor);
          const correctionState = actionRejectionState(
            {
              ...correctionContext.visibleState,
              relayMessages: turnFeedRelays,
              newRelayMessages: turnFeedRelays,
              harnessWakeReason: 'action-rejection-correction',
            },
            decision,
            lastActionError,
            correctionContext.tools,
          );
          actionContext = correctionContext;
          try {
            decision = await decideWithRetries(
              provider,
              {
                bot: activeBot,
                visibleState: correctionState,
                tools: correctionContext.tools,
                round,
                mode: 'turn',
                wakeContext: {
                  reason: 'turn',
                  summary: `${activeBot.name}'s previous action was rejected by the runtime. Use the fresh visible state and currentPhase.tools to choose corrected legal arguments.`,
                  privateReplyTo: turnWakeContext.privateReplyTo,
                  messages: turnFeedRelays,
                },
              },
              { type: 'turn', relayCursor: `correction-${previousCursor}->${correctionContext.nextRelayCursor}` },
              budgetProviders,
            );
          } catch (error) {
            if (isModelTimeoutError(error)) {
              const advanced = await waitForRuntimeAdvanceAfterModelFailure(gameId, activeBot, provider, round, error, 'model_timeout');
              if (advanced) {
                lastActionError = undefined;
                yieldedToRuntime = true;
                break;
              }
            }
            throw error;
          }
        }
        if (lastActionError) {
          await appendJsonlArtifact('errors.jsonl', {
            type: 'action_not_submitted_after_correction',
            bot: activeBot.name,
            playerId: activeBot.playerId,
            provider: provider.name,
            model: provider.model,
            round,
            action: decision.action,
            availableTools: availableToolNames(actionContext.tools),
            error: formatError(lastActionError),
          });
          const advanced = await waitForRuntimeAdvanceAfterModelFailure(gameId, activeBot, provider, round, lastActionError, 'invalid_model_action');
          if (advanced) {
            yieldedToRuntime = true;
          } else {
            throw new Error(`${activeBot.name}: no valid runtime-advertised action after correction and runtime did not advance: ${formatError(lastActionError)}`);
          }
        }
        if (yieldedToRuntime) break;
      } else {
        console.log(`  ${activeBot.name}: not their turn (currentPlayer=${currentPlayerId}), skipping`);
        actedThisRound.add(currentPlayerId);
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
      await runCommunicationSweeps(bots, providers, round, nextRelayCursorByBot);
    }
  }

  const finalInspect = await inspect(gameId);
  const finalDiagnostics = isRecord(finalInspect.gameInspect) ? finalInspect.gameInspect : {};
  const finalGameState = isRecord(finalDiagnostics.gameState) ? finalDiagnostics.gameState : {};
  const finalPhase = typeof finalGameState.phase === 'string' ? finalGameState.phase : 'unknown';
  const finalRound = getNumber(finalGameState.round, 0);
  const relayMessages = Array.isArray(finalDiagnostics.relayMessages) ? finalDiagnostics.relayMessages : [];
  const messagingRelays = relayMessages.filter(isMessagingRelay);
  const modelChatMessages = messagingRelays.filter((message) => !isSystemRelay(message));
  const summary = {
    runId: RUN_ID,
    lobbyId,
    gameId,
    inspectUrl: `${WEB_BASE_URL}/inspect/${gameId}`,
    gameUrl: `${WEB_BASE_URL}/game/${gameId}`,
    artifactDir: ARTIFACTS_ENABLED ? RUN_DIR : undefined,
    finalPhase,
    finalRound,
    stoppedReason: finalPhase === 'finished' ? 'game_finished' : 'harness_round_limit',
    reasoningMessages: relayMessages.filter((message) => isRecord(message) && message.type === 'reasoning').length,
    chatMessages: modelChatMessages.length,
    publicMessages: modelChatMessages.filter((message) => !isDmRelay(message)).length,
    dmMessages: modelChatMessages.filter(isDmRelay).length,
    systemMessages: messagingRelays.filter(isSystemRelay).length,
    usage: totalUsage(budgetProviders),
    usageByBot: bots.map((bot) => {
      const provider = providerForBot(providers, bot);
      return {
        name: bot.name,
        playerId: bot.playerId,
        provider: provider.name,
        model: provider.model,
        usage: providerUsage(provider),
      };
    }),
  };
  await writeJsonArtifact('summary.json', summary);
  await writeJsonArtifact('costs.json', {
    total: totalUsage(budgetProviders),
    byBot: bots.map((bot) => {
      const provider = providerForBot(providers, bot);
      return {
        name: bot.name,
        playerId: bot.playerId,
        provider: provider.name,
        model: provider.model,
        usage: providerUsage(provider),
      };
    }),
  });
  await appendJsonlArtifact('games.jsonl', {
    type: finalPhase === 'finished' ? 'game_finished' : 'harness_stopped_before_game_finished',
    lobbyId,
    gameId,
    phase: finalPhase,
    round: finalRound,
    summary,
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
