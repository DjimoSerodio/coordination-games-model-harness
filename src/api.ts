import { Wallet } from 'ethers';

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  retryUnsafeMethods?: boolean;
}

export interface JsonRequestOptions {
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
}

export interface JsonFetchResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}

interface JsonParseResult {
  json: unknown;
  parseError: string | undefined;
}

export interface AuthResult {
  token: string;
  playerId: string;
  address: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

const DEFAULT_GAME_API_TIMEOUT_MS = envInt('HARNESS_GAME_API_TIMEOUT_MS', 10_000, 1);
const DEFAULT_GAME_API_RETRIES = envInt('HARNESS_GAME_API_RETRIES', 2, 0);
const DEFAULT_GAME_API_RETRY_BASE_DELAY_MS = envInt('HARNESS_GAME_API_RETRY_BASE_DELAY_MS', 250, 0);

export function gameApiRetryDefaults(): Required<JsonRequestOptions> {
  return {
    timeoutMs: DEFAULT_GAME_API_TIMEOUT_MS,
    retries: DEFAULT_GAME_API_RETRIES,
    retryBaseDelayMs: DEFAULT_GAME_API_RETRY_BASE_DELAY_MS,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestTimeoutMs(opts: JsonRequestOptions): number {
  return Number.isFinite(opts.timeoutMs) && opts.timeoutMs !== undefined && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_GAME_API_TIMEOUT_MS;
}

function requestRetries(opts: JsonRequestOptions): number {
  return Number.isFinite(opts.retries) && opts.retries !== undefined && opts.retries >= 0
    ? Math.floor(opts.retries)
    : DEFAULT_GAME_API_RETRIES;
}

function requestRetryBaseDelayMs(opts: JsonRequestOptions): number {
  return Number.isFinite(opts.retryBaseDelayMs) && opts.retryBaseDelayMs !== undefined && opts.retryBaseDelayMs >= 0
    ? opts.retryBaseDelayMs
    : DEFAULT_GAME_API_RETRY_BASE_DELAY_MS;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSafeMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS';
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text: string): JsonParseResult {
  try {
    return { json: text ? JSON.parse(text) : null, parseError: undefined };
  } catch (error) {
    return {
      json: { _raw: text, _parseError: error instanceof Error ? error.message : String(error) },
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  opts: JsonRequestOptions = {},
): Promise<JsonFetchResult> {
  const timeoutMs = requestTimeoutMs(opts);
  const retries = requestRetries(opts);
  const retryBaseDelayMs = requestRetryBaseDelayMs(opts);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs, label);
      const text = await response.text();
      const { json, parseError } = parseJson(text);
      if (!response.ok && shouldRetryStatus(response.status) && attempt < retries) {
        lastError = new Error(`${label} -> ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
      } else if (response.ok && parseError) {
        throw new Error(`${label} returned invalid JSON: ${parseError}; body=${text.slice(0, 500)}`);
      } else {
        return { ok: response.ok, status: response.status, json, text };
      }
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
    }
    if (attempt < retries && retryBaseDelayMs > 0) {
      await sleep(retryBaseDelayMs * 2 ** attempt);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${retries + 1} attempt(s): ${message}`);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected string response field: ${key}`);
  return value;
}

export async function api(server: string, path: string, opts: ApiOptions = {}): Promise<unknown> {
  const method = opts.method ?? 'GET';
  const requestOptions: JsonRequestOptions = {};
  if (opts.timeoutMs !== undefined) requestOptions.timeoutMs = opts.timeoutMs;
  const retries = opts.retries ?? (isSafeMethod(method) || opts.retryUnsafeMethods === true ? undefined : 0);
  if (retries !== undefined) requestOptions.retries = retries;
  if (opts.retryBaseDelayMs !== undefined) requestOptions.retryBaseDelayMs = opts.retryBaseDelayMs;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const result = await fetchJsonWithRetry(`${server}${path}`, init, `${method} ${path}`, requestOptions);
  if (!result.ok) {
    throw new Error(`${method} ${path} -> ${result.status}: ${JSON.stringify(result.json)}`);
  }
  return result.json;
}

export async function authenticate(
  server: string,
  privateKey: string,
  name: string,
): Promise<AuthResult> {
  const wallet = new Wallet(privateKey);
  const challenge = await api(server, '/api/player/auth/challenge', { method: 'POST' });
  if (!isRecord(challenge)) throw new Error('Auth challenge returned a non-object response');
  const nonce = requireString(challenge, 'nonce');
  const message = requireString(challenge, 'message');
  const signature = await wallet.signMessage(message);
  const verified = await api(server, '/api/player/auth/verify', {
    method: 'POST',
    body: { nonce, signature, address: wallet.address, name },
  });
  if (!isRecord(verified)) throw new Error('Auth verify returned a non-object response');
  return {
    token: requireString(verified, 'token'),
    playerId: requireString(verified, 'agentId'),
    address: wallet.address,
  };
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} returned a non-object response`);
  return value;
}
