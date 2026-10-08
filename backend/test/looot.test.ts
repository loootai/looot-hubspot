import { describe, expect, it } from 'vitest';
import {
  buildIdempotencyKey,
  checkLoootToken,
  cleanInput,
  LoootError,
  runLoootJob,
  toStableJson,
} from '../src/looot.js';
import { FALLBACK_PRICES, PriceSource } from '../src/prices.js';
import { makeFetch, NOW } from './helpers.js';

const options = (impl: typeof fetch, maxCostUsd: number | null = null) => ({
  token: 'agent-token-for-tests',
  maxCostUsd,
  fetchImpl: impl,
  now: new Date(NOW),
});

describe('idempotency key', () => {
  it('is hubspot- plus 40 hex characters', () => {
    expect(buildIdempotencyKey('job:people.email.find', { a: '1' }, new Date(NOW))).toMatch(/^hubspot-[0-9a-f]{40}$/);
  });

  it('ignores key order and changes with the input, the job and the UTC day', () => {
    const day = new Date(NOW);
    const base = buildIdempotencyKey('job:x', { a: '1', b: '2' }, day);
    expect(buildIdempotencyKey('job:x', { b: '2', a: '1' }, day)).toBe(base);
    expect(buildIdempotencyKey('job:x', { a: '1', b: '3' }, day)).not.toBe(base);
    expect(buildIdempotencyKey('job:y', { a: '1', b: '2' }, day)).not.toBe(base);
    expect(buildIdempotencyKey('job:x', { a: '1', b: '2' }, new Date(NOW + 86_400_000))).not.toBe(base);
    expect(buildIdempotencyKey('job:x', { a: '1', b: '2' }, new Date(NOW + 3_600_000))).toBe(base);
  });

  it('stable json sorts nested keys', () => {
    expect(toStableJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
});

describe('cleanInput', () => {
  it('trims and drops empty values', () => {
    expect(cleanInput({ a: ' x ', b: '', c: '   ', d: null, e: undefined })).toEqual({ a: 'x' });
  });
});

describe('runLoootJob', () => {
  it('posts the exact body with fallback true when there is no cap', async () => {
    const { impl, calls } = makeFetch({ 'POST https://api.looot.ai/v1/runs': () => ({ body: { runId: 'r1', status: 'completed' } }) });
    await runLoootJob('job:people.email.verify', { email: 'a@example.com' }, options(impl));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.Authorization).toBe('Bearer agent-token-for-tests');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      endpointId: 'job:people.email.verify',
      input: { email: 'a@example.com' },
      idempotencyKey: buildIdempotencyKey('job:people.email.verify', { email: 'a@example.com' }, new Date(NOW)),
      wait: 25,
      fallback: true,
    });
  });

  it('sends the cost cap as fallback.maxCostUsd', async () => {
    const { impl, calls } = makeFetch({ 'POST https://api.looot.ai/v1/runs': () => ({ body: { runId: 'r1', status: 'completed' } }) });
    await runLoootJob('job:company.enrich', { domain: 'a.co' }, options(impl, 0.05));
    expect(JSON.parse(calls[0]!.body).fallback).toEqual({ enabled: true, maxCostUsd: 0.05 });
  });

  it('turns 401 into an unauthorized error', async () => {
    const { impl } = makeFetch({ 'POST https://api.looot.ai/v1/runs': () => ({ status: 401, body: {} }) });
    await expect(runLoootJob('job:x', {}, options(impl))).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('turns 402 into a message with the top-up link and says nothing was charged', async () => {
    const { impl } = makeFetch({
      'POST https://api.looot.ai/v1/runs': () => ({
        status: 402,
        body: { error: { message: 'Balance too low.' }, topUp: { dashboardUrl: 'https://looot.ai/top-up' } },
      }),
    });
    const error = await runLoootJob('job:x', {}, options(impl)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoootError);
    expect((error as LoootError).code).toBe('insufficient_balance');
    expect((error as LoootError).message).toContain('Nothing was charged');
    expect((error as LoootError).message).toContain('https://looot.ai/top-up');
  });

  it('throws on a 201 that carries a failed run', async () => {
    const { impl } = makeFetch({
      'POST https://api.looot.ai/v1/runs': () => ({
        status: 201,
        body: { runId: 'r9', status: 'failed', error: { code: 'provider_down', message: 'No provider answered.' } },
      }),
    });
    await expect(runLoootJob('job:x', {}, options(impl))).rejects.toMatchObject({ code: 'provider_down' });
  });
});

describe('checkLoootToken', () => {
  it('is true on 200, false on 401', async () => {
    const ok = makeFetch({ 'GET https://api.looot.ai/v1/balance': () => ({ body: {} }) });
    const bad = makeFetch({ 'GET https://api.looot.ai/v1/balance': () => ({ status: 401 }) });
    expect(await checkLoootToken('t', ok.impl)).toBe(true);
    expect(await checkLoootToken('t', bad.impl)).toBe(false);
  });
});

describe('prices', () => {
  const overview = {
    categories: [
      {
        platforms: [
          {
            jobs: [
              { id: 'people.email.find', cheapestPerCall: 0.004 },
              { id: 'people.email.verify', cheapestPerCall: 0.002 },
              { id: 'company.enrich', cheapestPerCall: 0.003 },
            ],
          },
        ],
      },
    ],
  };

  it('reads the three prices from the catalog and caches them for five minutes', async () => {
    let now = NOW;
    const { impl, calls } = makeFetch({ 'GET https://api.looot.ai/v1/catalog/overview?depth=jobs': () => ({ body: overview }) });
    const source = new PriceSource(impl, () => now);
    const first = await source.get();
    expect(first).toMatchObject({ source: 'live', asOf: '2026-10-09', prices: { findWorkEmail: 0.004, verifyEmail: 0.002, enrichCompany: 0.003 } });
    now += 4 * 60_000;
    await source.get();
    expect(calls).toHaveLength(1);
    now += 2 * 60_000;
    await source.get();
    expect(calls).toHaveLength(2);
  });

  it('uses the dated fallback when the catalog is down or missing a job', async () => {
    const down = makeFetch({ 'GET https://api.looot.ai/': () => ({ status: 503 }) });
    expect(await new PriceSource(down.impl, () => NOW).get()).toEqual(FALLBACK_PRICES);
    const partial = makeFetch({
      'GET https://api.looot.ai/': () => ({ body: { categories: [{ platforms: [{ jobs: [{ id: 'company.enrich', cheapestPerCall: 1 }] }] }] } }),
    });
    expect((await new PriceSource(partial.impl, () => NOW).get()).source).toBe('fallback');
    expect(FALLBACK_PRICES.asOf).toBe('2026-10-09');
    expect(FALLBACK_PRICES.prices).toEqual({ findWorkEmail: 0.003598, verifyEmail: 0.00145, enrichCompany: 0.0019 });
  });
});
