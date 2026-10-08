import { computeV3Signature } from '../src/signature.js';
import type { Config } from '../src/config.js';
import { MemoryTokenStore } from '../src/store.js';

export const CONFIG: Config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://backend.example.com/oauth/callback',
  publicBaseUrl: 'https://backend.example.com',
  maxCostUsd: null,
  allowSignatureV2: false,
};

export const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

export type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A stand-in for fetch: routes by "METHOD url-prefix" and records every call. No network. */
export const makeFetch = (routes: Record<string, (call: Call) => { status?: number; body?: unknown }>) => {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = {
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const key = Object.keys(routes).find((route) => {
      const [m, ...rest] = route.split(' ');
      return m === method && url.startsWith(rest.join(' '));
    });
    if (!key) return new Response(JSON.stringify({ error: `no route for ${method} ${url}` }), { status: 599 });
    const answer = routes[key]!(call);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
};

/** Pass null for an account that has not pasted a looot token yet. */
export const seededStore = async (loootToken: string | null = 'agent-token-for-tests') => {
  const store = new MemoryTokenStore();
  await store.set({ portalId: '777', accessToken: 'hs-access', refreshToken: 'hs-refresh', expiresAt: NOW + 3_600_000, ...(loootToken === null ? {} : { loootToken }) });
  return store;
};

/** Signs a request the way HubSpot does, so handler tests can send valid calls. */
export const signed = (method: string, pathAndQuery: string, body = '', nowMs = NOW) => {
  const timestamp = String(nowMs);
  const signature = computeV3Signature(CONFIG.clientSecret, method, `${CONFIG.publicBaseUrl}${pathAndQuery}`, body, timestamp);
  return {
    method,
    url: pathAndQuery,
    body,
    headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp } as Record<string, string | undefined>,
  };
};
