import { describe, expect, it } from 'vitest';
import { createHandler } from '../src/server.js';
import { CONFIG, makeFetch, NOW, seededStore, signed, type Call } from './helpers.js';

const CRM = 'https://api.hubapi.com/crm/objects/2026-09';
const RUNS = 'POST https://api.looot.ai/v1/runs';

const setup = async (routes: Record<string, (call: Call) => { status?: number; body?: unknown }>, loootToken: string | null = 'agent-token-for-tests') => {
  const store = await seededStore(loootToken);
  const stub = makeFetch(routes);
  const handle = createHandler({ config: CONFIG, store, fetchImpl: stub.impl, nowMs: () => NOW });
  return { ...stub, store, handle };
};

describe('GET /api/prices', () => {
  it('returns the live prices and whether the account has a token', async () => {
    const overview = {
      categories: [{ platforms: [{ jobs: [{ id: 'people.email.find', cheapestPerCall: 0.01 }, { id: 'people.email.verify', cheapestPerCall: 0.02 }, { id: 'company.enrich', cheapestPerCall: 0.03 }] }] }],
    };
    const { handle } = await setup({ 'GET https://api.looot.ai/v1/catalog/overview': () => ({ body: overview }) });
    const body = JSON.parse((await handle(signed('GET', '/api/prices?portalId=777'))).body);
    expect(body).toMatchObject({ ok: true, source: 'live', hasToken: true, prices: { findWorkEmail: 0.01 } });
  });

  it('falls back to the dated prices when the catalog is down, and reports no token', async () => {
    const { handle } = await setup({ 'GET https://api.looot.ai/': () => ({ status: 500 }) }, null);
    const body = JSON.parse((await handle(signed('GET', '/api/prices?portalId=777'))).body);
    expect(body).toMatchObject({ source: 'fallback', asOf: '2026-10-09', hasToken: false, prices: { findWorkEmail: 0.003598 } });
  });
});

describe('POST /api/looot-token', () => {
  const send = (handle: Awaited<ReturnType<typeof setup>>['handle'], token: string) =>
    handle(signed('POST', '/api/looot-token?portalId=777', JSON.stringify({ token })));

  it('checks the token with /v1/balance, saves it and never echoes it', async () => {
    const { handle, store, calls } = await setup({ 'GET https://api.looot.ai/v1/balance': () => ({ body: {} }) }, null);
    const response = await send(handle, 'new-agent-token');
    expect(JSON.parse(response.body)).toEqual({ ok: true, message: 'Token saved.' });
    expect(response.body).not.toContain('new-agent-token');
    expect(calls[0]!.headers.Authorization).toBe('Bearer new-agent-token');
    expect((await store.get('777'))?.loootToken).toBe('new-agent-token');
  });

  it('does not save a token looot rejects', async () => {
    const { handle, store } = await setup({ 'GET https://api.looot.ai/v1/balance': () => ({ status: 401 }) }, null);
    const body = JSON.parse((await send(handle, 'bad')).body);
    expect(body.ok).toBe(false);
    expect((await store.get('777'))?.loootToken).toBeUndefined();
  });

  it('rejects an empty token and an unknown account', async () => {
    const { handle } = await setup({});
    expect((await send(handle, '  ')).status).toBe(400);
    const unknown = signed('POST', '/api/looot-token?portalId=999', JSON.stringify({ token: 'x' }));
    expect((await handle(unknown)).status).toBe(404);
  });
});

describe('POST /workflow/enrich', () => {
  const payload = (lookup: string, objectType = 'CONTACT') =>
    JSON.stringify({
      callbackId: 'ap-777-1-0',
      origin: { portalId: 777, actionDefinitionId: 1 },
      context: { source: 'WORKFLOWS', workflowId: 5 },
      object: { objectId: 12, objectType },
      inputFields: { lookup },
    });

  it('answers with the documented outputFields shape for verify email', async () => {
    const { handle } = await setup({
      [`GET ${CRM}/contacts/12`]: () => ({ body: { id: '12', properties: { email: 'a@example.com', looot_email_status: null } } }),
      [RUNS]: () => ({ body: { runId: 'w1', status: 'completed', actualCost: 0.00145, servedProviderId: 'p', normalized: { fields: { status: 'valid', deliverable: true } } } }),
      [`PATCH ${CRM}/contacts/12`]: () => ({ body: {} }),
    });
    const response = await handle(signed('POST', '/workflow/enrich', payload('verify_email')));
    expect(JSON.parse(response.body)).toEqual({
      outputFields: {
        email: 'a@example.com',
        emailStatus: 'valid',
        deliverable: 'true',
        industry: '',
        size: '',
        costUsd: 0.00145,
        provider: 'p',
        runId: 'w1',
        message: 'a@example.com is valid.',
        hs_execution_state: 'SUCCESS',
      },
    });
  });

  it('enriches the associated company when a contact is enrolled', async () => {
    const { handle, calls } = await setup({
      [`GET ${CRM}/contacts/12/associations/companies`]: () => ({ body: { results: [{ toObjectId: 55 }] } }),
      [`GET ${CRM}/companies/55`]: () => ({ body: { id: '55', properties: { name: 'E', domain: 'e.example.com' } } }),
      [RUNS]: () => ({ body: { runId: 'w2', status: 'completed', normalized: { fields: { industry: 'Machinery', size: '11-50' } } } }),
      [`PATCH ${CRM}/companies/55`]: () => ({ body: {} }),
    });
    const out = JSON.parse((await handle(signed('POST', '/workflow/enrich', payload('enrich_company')))).body).outputFields;
    expect(out).toMatchObject({ industry: 'Machinery', size: '11-50', runId: 'w2', hs_execution_state: 'SUCCESS' });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('continues the workflow with a message when looot fails', async () => {
    const { handle } = await setup({
      [`GET ${CRM}/contacts/12`]: () => ({ body: { id: '12', properties: { email: 'a@example.com' } } }),
      [RUNS]: () => ({ status: 402, body: { error: { message: 'Low balance.' } } }),
    });
    const out = JSON.parse((await handle(signed('POST', '/workflow/enrich', payload('verify_email')))).body).outputFields;
    expect(out.hs_execution_state).toBe('FAIL_CONTINUE');
    expect(out.message).toContain('Nothing was charged');
  });

  it('refuses email lookups on a company and unknown lookups', async () => {
    const { handle, calls } = await setup({});
    const a = JSON.parse((await handle(signed('POST', '/workflow/enrich', payload('find_work_email', 'COMPANY')))).body);
    const b = JSON.parse((await handle(signed('POST', '/workflow/enrich', payload('nope')))).body);
    expect(a.outputFields.hs_execution_state).toBe('FAIL_CONTINUE');
    expect(b.outputFields.hs_execution_state).toBe('FAIL_CONTINUE');
    expect(calls).toHaveLength(0);
  });

  it('is signature checked', async () => {
    const { handle } = await setup({});
    const request = signed('POST', '/workflow/enrich', payload('verify_email'));
    expect((await handle({ ...request, headers: {} })).status).toBe(401);
  });
});

describe('misc', () => {
  it('answers /health and 404 on unknown routes', async () => {
    const { handle } = await setup({});
    expect((await handle({ method: 'GET', url: '/health', headers: {}, body: '' })).status).toBe(200);
    expect((await handle({ method: 'GET', url: '/nope', headers: {}, body: '' })).status).toBe(404);
  });
});
