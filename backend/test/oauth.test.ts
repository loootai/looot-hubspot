import { describe, expect, it } from 'vitest';
import { HubSpotClient, TOKEN_URL } from '../src/hubspot.js';
import { OPTIONAL_SCOPES, REQUIRED_SCOPES } from '../src/scopes.js';
import { checkState, createHandler, makeState } from '../src/server.js';
import { MemoryTokenStore } from '../src/store.js';
import { CONFIG, makeFetch, NOW, seededStore } from './helpers.js';

const tokenAnswer = (body: object) => ({ body });

describe('install url', () => {
  it('carries client id, redirect uri, scopes and state', () => {
    const client = new HubSpotClient(CONFIG, new MemoryTokenStore(), makeFetch({}).impl, () => NOW);
    const url = new URL(client.installUrl('abc'));
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(' '));
    expect(url.searchParams.get('optional_scope')).toBe(OPTIONAL_SCOPES.join(' '));
    expect(url.searchParams.get('state')).toBe('abc');
  });
});

describe('state', () => {
  it('accepts a fresh state and rejects tampered, stale and missing ones', () => {
    const state = makeState('secret', NOW);
    expect(checkState('secret', state, NOW + 1000)).toBe(true);
    expect(checkState('other', state, NOW + 1000)).toBe(false);
    expect(checkState('secret', state, NOW + 16 * 60_000)).toBe(false);
    expect(checkState('secret', `${NOW}.deadbeef`, NOW)).toBe(false);
    expect(checkState('secret', null, NOW)).toBe(false);
  });
});

describe('code exchange', () => {
  it('posts a form body to the v3 token endpoint and stores tokens under hub_id', async () => {
    const store = new MemoryTokenStore();
    const { impl, calls } = makeFetch({
      [`POST ${TOKEN_URL}`]: () => tokenAnswer({ access_token: 'A1', refresh_token: 'R1', expires_in: 1800, hub_id: 4242 }),
    });
    const portalId = await new HubSpotClient(CONFIG, store, impl, () => NOW).exchangeCode('the-code');
    expect(portalId).toBe('4242');
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: CONFIG.redirectUri,
    });
    expect(await store.get('4242')).toEqual({ portalId: '4242', accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 1_800_000 });
  });

  it('keeps an existing looot token when the account installs again', async () => {
    const store = await seededStore('keep-me');
    await store.set({ ...(await store.get('777'))!, portalId: '4242' });
    const { impl } = makeFetch({ [`POST ${TOKEN_URL}`]: () => tokenAnswer({ access_token: 'A2', refresh_token: 'R2', expires_in: 1800, hub_id: 4242 }) });
    await new HubSpotClient(CONFIG, store, impl, () => NOW).exchangeCode('c');
    expect((await store.get('4242'))?.loootToken).toBe('keep-me');
  });
});

describe('refresh', () => {
  it('refreshes an expired access token once and saves the new one', async () => {
    const store = new MemoryTokenStore();
    await store.set({ portalId: '9', accessToken: 'old', refreshToken: 'R', expiresAt: NOW - 1 });
    const { impl, calls } = makeFetch({
      [`POST ${TOKEN_URL}`]: () => tokenAnswer({ access_token: 'new', refresh_token: 'R', expires_in: 1800 }),
    });
    const client = new HubSpotClient(CONFIG, store, impl, () => NOW);
    expect((await client.activeRecord('9')).accessToken).toBe('new');
    expect((await client.activeRecord('9')).accessToken).toBe('new');
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('refresh_token');
    expect((await store.get('9'))?.expiresAt).toBe(NOW + 1_800_000);
  });

  it('refreshes and retries once when HubSpot answers 401', async () => {
    const store = await seededStore();
    let reads = 0;
    const { impl, calls } = makeFetch({
      'GET https://api.hubapi.com/crm/objects/2026-09/contacts/5': () => (++reads === 1 ? { status: 401 } : { body: { id: '5', properties: {} } }),
      [`POST ${TOKEN_URL}`]: () => tokenAnswer({ access_token: 'fresh', refresh_token: 'hs-refresh', expires_in: 1800 }),
    });
    const client = new HubSpotClient(CONFIG, store, impl, () => NOW);
    await client.getObject('777', 'contacts', '5', ['email']);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[2]!.headers.Authorization).toBe('Bearer fresh');
  });
});

describe('oauth routes', () => {
  const build = (store = new MemoryTokenStore(), routes = {}) => {
    const fetchStub = makeFetch(routes);
    const handle = createHandler({ config: CONFIG, store, fetchImpl: fetchStub.impl, nowMs: () => NOW });
    return { handle, ...fetchStub, store };
  };

  it('redirects /oauth/install to HubSpot with a valid state', async () => {
    const { handle } = build();
    const response = await handle({ method: 'GET', url: '/oauth/install', headers: {}, body: '' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.Location!);
    expect(location.host).toBe('app.hubspot.com');
    expect(checkState(CONFIG.clientSecret, location.searchParams.get('state'), NOW)).toBe(true);
  });

  it('refuses a callback with a state we did not issue', async () => {
    const { handle, calls } = build();
    const response = await handle({ method: 'GET', url: '/oauth/callback?code=x&state=bad', headers: {}, body: '' });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('accepts a callback with no state, as HubSpot install URLs send none', async () => {
    const { handle, store } = build(new MemoryTokenStore(), {
      [`POST ${TOKEN_URL}`]: () => tokenAnswer({ access_token: 'A', refresh_token: 'R', expires_in: 1800, hub_id: 32 }),
      'POST https://api.hubapi.com/crm/properties/2026-09/': () => ({ body: {} }),
    });
    const response = await handle({ method: 'GET', url: '/oauth/callback?code=abc', headers: {}, body: '' });
    expect(response.status).toBe(200);
    expect((await store.get('32'))?.refreshToken).toBe('R');
  });

  it('exchanges the code, then creates the three properties', async () => {
    const { handle, calls, store } = build(new MemoryTokenStore(), {
      [`POST ${TOKEN_URL}`]: () => tokenAnswer({ access_token: 'A', refresh_token: 'R', expires_in: 1800, hub_id: 31 }),
      'POST https://api.hubapi.com/crm/properties/2026-09/': () => ({ body: {} }),
    });
    const state = makeState(CONFIG.clientSecret, NOW);
    const response = await handle({ method: 'GET', url: `/oauth/callback?code=abc&state=${state}`, headers: {}, body: '' });
    expect(response.status).toBe(200);
    expect((await store.get('31'))?.accessToken).toBe('A');
    const created = calls.filter((c) => c.url.includes('/crm/properties/')).map((c) => `${c.url.split('/').pop()}:${JSON.parse(c.body).name}`);
    expect(created).toEqual(['contacts:looot_email_status', 'companies:looot_industry', 'companies:looot_company_size']);
    expect(response.body).not.toContain('A');
  });
});
