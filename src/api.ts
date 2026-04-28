import { Wallet } from 'ethers';

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

export interface AuthResult {
  token: string;
  playerId: string;
  address: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected string response field: ${key}`);
  return value;
}

export async function api(server: string, path: string, opts: ApiOptions = {}): Promise<unknown> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const response = await fetch(`${server}${path}`, init);
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = { _raw: text, _parseError: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
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
