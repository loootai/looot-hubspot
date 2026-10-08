import { describe, expect, it } from 'vitest';
import { createHandler, type HttpResponse } from '../src/server.js';
import { buildIdempotencyKey } from '../src/looot.js';
import { CONFIG, makeFetch, NOW, seededStore, signed, type Call } from './helpers.js';

const CRM = 'https://api.hubapi.com/crm/objects/2026-09';
const RUNS = 'POST https://api.looot.ai/v1/runs';

const setup = async (
  routes: Record<string, (call: Call) => { status?: number; body?: unknown }>,
  loootToken: string | null = 'agent-token-for-tests',
) => {
  const store = await seededStore(loootToken);
  const stub = makeFetch(routes);
  const handle = createHandler({ config: CONFIG, store, fetchImpl: stub.impl, nowMs: () => NOW });
  const post = (name: string, body: object): Promise<HttpResponse> =>
    handle(signed('POST', `/api/actions/${name}?portalId=777&userId=1`, JSON.stringify(body)));
  return { ...stub, store, handle, post };
};

const parse = (response: HttpResponse) => JSON.parse(response.body);
const loootCalls = (calls: Call[]) => calls.filter((c) => c.url === 'https://api.looot.ai/v1/runs');
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH').map((c) => ({ url: c.url, properties: JSON.parse(c.body).properties }));

describe('find work email', () => {
  const contact = { id: '11', properties: { firstname: 'Ada', lastname: 'Lovelace', email: null, company: 'Analytical Engines', website: 'https://www.analytical.example.com/about', hs_linkedin_url: null } };

  it('sends the exact looot body and writes the email to the empty field', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/11`]: () => ({ body: contact }),
      [RUNS]: () => ({ status: 201, body: { runId: 'run-1', status: 'completed', actualCost: 0.0036, servedProviderId: 'prov', normalized: { fields: { email: 'ada@example.com', check: 'valid' } } } }),
      [`PATCH ${CRM}/contacts/11`]: () => ({ body: {} }),
    });
    const body = parse(await post('find-work-email', { objectId: '11', confirm: true }));
    const input = { first_name: 'Ada', last_name: 'Lovelace', domain: 'analytical.example.com', company: 'Analytical Engines' };
    expect(JSON.parse(loootCalls(calls)[0]!.body)).toEqual({
      endpointId: 'job:people.email.find',
      input,
      idempotencyKey: buildIdempotencyKey('job:people.email.find', input, new Date(NOW)),
      wait: 25,
      fallback: true,
    });
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({ found: true, values: { email: 'ada@example.com' }, run: { runId: 'run-1', costUsd: 0.0036, provider: 'prov' } });
    expect(patches(calls)).toEqual([{ url: `${CRM}/contacts/11`, properties: { email: 'ada@example.com' } }]);
  });

  it('does not call looot when the contact already has an email', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/11`]: () => ({ body: { id: '11', properties: { ...contact.properties, email: 'old@example.com' } } }),
    });
    const body = parse(await post('find-work-email', { objectId: '11', confirm: true }));
    expect(body.result).toMatchObject({ skipped: true, found: false });
    expect(loootCalls(calls)).toHaveLength(0);
    expect(patches(calls)).toHaveLength(0);
  });

  it('uses the associated company when the contact has no company or website', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/11/associations/companies`]: () => ({ body: { results: [{ toObjectId: 55 }] } }),
      [`GET ${CRM}/contacts/11?`]: () => ({ body: { id: '11', properties: { firstname: 'Ada', lastname: 'Lovelace', email: null } } }),
      [`GET ${CRM}/companies/55`]: () => ({ body: { id: '55', properties: { name: 'Engines Ltd', domain: 'engines.example.com' } } }),
      [RUNS]: () => ({ body: { runId: 'r', status: 'completed', normalized: { fields: { email: 'a@example.com' } } } }),
      [`PATCH ${CRM}/contacts/11`]: () => ({ body: {} }),
    });
    await post('find-work-email', { objectId: '11', confirm: true });
    expect(JSON.parse(loootCalls(calls)[0]!.body).input).toEqual({ first_name: 'Ada', last_name: 'Lovelace', domain: 'engines.example.com', company: 'Engines Ltd' });
  });

  it('says not found and writes nothing when looot has no normalized fields', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/11`]: () => ({ body: contact }),
      [RUNS]: () => ({ body: { runId: 'r', status: 'completed', actualCost: 0.01 } }),
    });
    const body = parse(await post('find-work-email', { objectId: '11', confirm: true }));
    expect(body.result.found).toBe(false);
    expect(body.result.message).toContain('no email');
    expect(patches(calls)).toHaveLength(0);
  });

  it('asks for a name before calling looot', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/11`]: () => ({ body: { id: '11', properties: { firstname: 'Ada', email: null, company: 'X' } } }),
    });
    const body = parse(await post('find-work-email', { objectId: '11', confirm: true }));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('missing_person');
    expect(loootCalls(calls)).toHaveLength(0);
  });
});

describe('verify email', () => {
  const contact = { id: '12', properties: { email: 'ada@example.com', looot_email_status: null } };
  const answer = { runId: 'v1', status: 'completed', actualCost: 0.00145, servedProviderId: 'p', normalized: { fields: { email: 'ada@example.com', status: 'valid', deliverable: true } } };

  it('writes the status to the app property when it is empty', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/12`]: () => ({ body: contact }),
      [RUNS]: () => ({ body: answer }),
      [`PATCH ${CRM}/contacts/12`]: () => ({ body: {} }),
    });
    const body = parse(await post('verify-email', { objectId: '12', confirm: true }));
    expect(JSON.parse(loootCalls(calls)[0]!.body).input).toEqual({ email: 'ada@example.com' });
    expect(body.result.values).toMatchObject({ emailStatus: 'valid', deliverable: true });
    expect(patches(calls)).toEqual([{ url: `${CRM}/contacts/12`, properties: { looot_email_status: 'valid' } }]);
  });

  it('never overwrites a status that is already set', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/contacts/12`]: () => ({ body: { id: '12', properties: { email: 'ada@example.com', looot_email_status: 'old' } } }),
      [RUNS]: () => ({ body: answer }),
    });
    const body = parse(await post('verify-email', { objectId: '12', confirm: true }));
    expect(patches(calls)).toHaveLength(0);
    expect(body.result.notWritten[0].property).toBe('looot_email_status');
  });

  it('reports a property that does not exist yet without failing the lookup', async () => {
    const { post } = await setup({
      [`GET ${CRM}/contacts/12`]: () => ({ body: contact }),
      [RUNS]: () => ({ body: answer }),
      [`PATCH ${CRM}/contacts/12`]: () => ({ status: 400 }),
    });
    const body = parse(await post('verify-email', { objectId: '12', confirm: true }));
    expect(body.ok).toBe(true);
    expect(body.result.notWritten[0].reason).toContain('does not exist');
  });

  it('needs an email on the contact', async () => {
    const { post } = await setup({ [`GET ${CRM}/contacts/12`]: () => ({ body: { id: '12', properties: { email: null } } }) });
    expect(parse(await post('verify-email', { objectId: '12', confirm: true })).error.code).toBe('missing_email');
  });
});

describe('enrich company', () => {
  const company = { id: '55', properties: { name: 'Engines Ltd', domain: 'engines.example.com', looot_industry: null, looot_company_size: 'old size' } };

  it('fills only the empty fields', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/companies/55`]: () => ({ body: company }),
      [RUNS]: () => ({ body: { runId: 'c1', status: 'completed', actualCost: 0.0019, normalized: { fields: { name: 'Engines Ltd', domain: 'engines.example.com', industry: 'Machinery', size: '51-200' } } } }),
      [`PATCH ${CRM}/companies/55`]: () => ({ body: {} }),
    });
    const body = parse(await post('enrich-company', { objectId: '55', confirm: true }));
    expect(JSON.parse(loootCalls(calls)[0]!.body).input).toEqual({ domain: 'engines.example.com', name: 'Engines Ltd' });
    expect(patches(calls)).toEqual([{ url: `${CRM}/companies/55`, properties: { looot_industry: 'Machinery' } }]);
    expect(body.result.notWritten).toEqual([{ property: 'looot_company_size', reason: 'already has a value' }]);
  });

  it('skips the call when both fields are filled', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/companies/55`]: () => ({ body: { id: '55', properties: { ...company.properties, looot_industry: 'x' } } }),
    });
    expect(parse(await post('enrich-company', { objectId: '55', confirm: true })).result.skipped).toBe(true);
    expect(loootCalls(calls)).toHaveLength(0);
  });

  it('treats missing normalized fields as not found', async () => {
    const { post, calls } = await setup({
      [`GET ${CRM}/companies/55`]: () => ({ body: { id: '55', properties: { name: 'X', domain: 'x.example.com' } } }),
      [RUNS]: () => ({ body: { runId: 'c2', status: 'completed' } }),
    });
    expect(parse(await post('enrich-company', { objectId: '55', confirm: true })).result.found).toBe(false);
    expect(patches(calls)).toHaveLength(0);
  });
});

describe('errors and guards', () => {
  const contactRoutes = { [`GET ${CRM}/contacts/12`]: () => ({ body: { id: '12', properties: { email: 'a@example.com' } } }) };

  it('refuses to run without confirm: true, before any call', async () => {
    const { post, calls } = await setup(contactRoutes);
    const response = await post('verify-email', { objectId: '12' });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('asks for a token when the account has none', async () => {
    const { post, calls } = await setup(contactRoutes, null);
    expect(parse(await post('verify-email', { objectId: '12', confirm: true })).error.code).toBe('missing_token');
    expect(calls).toHaveLength(0);
  });

  it('passes on looot 401 and 402 as plain messages', async () => {
    const unauthorized = await setup({ ...contactRoutes, [RUNS]: () => ({ status: 401 }) });
    expect(parse(await unauthorized.post('verify-email', { objectId: '12', confirm: true })).error.code).toBe('unauthorized');
    const broke = await setup({ ...contactRoutes, [RUNS]: () => ({ status: 402, body: { error: { message: 'Low balance.' }, topUp: { dashboardUrl: 'https://looot.ai/top' } } }) });
    const body = parse(await broke.post('verify-email', { objectId: '12', confirm: true }));
    expect(body.error.code).toBe('insufficient_balance');
    expect(body.error.message).toContain('https://looot.ai/top');
  });

  it('reports a failed run', async () => {
    const { post } = await setup({ ...contactRoutes, [RUNS]: () => ({ status: 201, body: { runId: 'f1', status: 'failed', error: { message: 'boom' } } }) });
    expect(parse(await post('verify-email', { objectId: '12', confirm: true })).error.message).toContain('ended failed');
  });

  it('rejects an unsigned call, a tampered body and a stale call', async () => {
    const { handle, calls } = await setup(contactRoutes);
    const good = signed('POST', '/api/actions/verify-email?portalId=777', JSON.stringify({ objectId: '12', confirm: true }));
    expect((await handle({ ...good, headers: {} })).status).toBe(401);
    expect((await handle({ ...good, body: JSON.stringify({ objectId: '13', confirm: true }) })).status).toBe(401);
    const stale = signed('POST', '/api/actions/verify-email?portalId=777', '{}', NOW - 400_000);
    expect((await handle(stale)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
