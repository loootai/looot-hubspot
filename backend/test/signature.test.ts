import { describe, expect, it } from 'vitest';
import { computeV2Signature, computeV3Signature, normalizeUri, verifyHubSpotRequest } from '../src/signature.js';

// Vectors from HubSpot's request validation page (read 2026-10-09).
const V3_SECRET = 'cfc68c0b-4b4e-4ef8-b764-95350e4ea479';
const V3_URL = 'https://webhook.site/335453f5-94b3-49d9-b684-a55354d4b8df';
const V3_BODY =
  '[{"eventId":531833541,"subscriptionId":3923621,"portalId":48807704,"appId":16111050,"occurredAt":1752613920733,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":138017612137,"changeFlag":"CREATED","changeSource":"CRM_UI","sourceId":"userId:76023669"}]';
const V3_TIMESTAMP = '1752613922216';
const V3_SIGNATURE = 'gbj1XPRvUt0noT7i7fXfTzOD4sLzQmf0VT28ZYq0EYg=';

const request = (overrides: { body?: string; signature?: string; timestamp?: string } = {}) => ({
  method: 'POST',
  url: V3_URL,
  rawBody: overrides.body ?? V3_BODY,
  headers: {
    'x-hubspot-signature-v3': overrides.signature ?? V3_SIGNATURE,
    'x-hubspot-request-timestamp': overrides.timestamp ?? V3_TIMESTAMP,
  },
});

describe('v3 signature', () => {
  it('matches the vector in the HubSpot docs', () => {
    expect(computeV3Signature(V3_SECRET, 'POST', V3_URL, V3_BODY, V3_TIMESTAMP)).toBe(V3_SIGNATURE);
  });

  it('accepts a valid request inside the five minute window', () => {
    expect(verifyHubSpotRequest(request(), V3_SECRET, Number(V3_TIMESTAMP) + 1000)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const result = verifyHubSpotRequest(request({ body: V3_BODY.replace('48807704', '48807705') }), V3_SECRET, Number(V3_TIMESTAMP));
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp even with a matching signature', () => {
    const result = verifyHubSpotRequest(request(), V3_SECRET, Number(V3_TIMESTAMP) + 301_000);
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a wrong secret and a missing signature', () => {
    expect(verifyHubSpotRequest(request(), 'other-secret', Number(V3_TIMESTAMP))).toEqual({ ok: false, reason: 'bad_signature' });
    const bare = { method: 'POST', url: V3_URL, rawBody: '', headers: {} };
    expect(verifyHubSpotRequest(bare, V3_SECRET, Number(V3_TIMESTAMP))).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('decodes only the listed characters in the query string', () => {
    expect(normalizeUri('https://x.example.com/a%2Fb?q=a%40b%2Cc%20d#frag')).toBe('https://x.example.com/a%2Fb?q=a@b,c%20d');
  });
});

describe('v2 signature', () => {
  const secret = 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy';
  const url = 'https://www.example.com/webhook_uri';
  const body = '{"example_field":"example_value"}';

  it('matches the POST vector in the HubSpot docs', () => {
    expect(computeV2Signature(secret, 'POST', url, body)).toBe('9569219f8ba981ffa6f6f16aa0f48637d35d728c7e4d93d0d52efaa512af7900');
  });

  it('matches the GET vector in the HubSpot docs', () => {
    expect(computeV2Signature(secret, 'GET', url, '')).toBe('eee2dddcc73c94d699f5e395f4b9d454a069a6855fbfa152e91e88823087200e');
  });

  it('is refused unless allowed, because v2 has no timestamp', () => {
    const headers = {
      'x-hubspot-signature': computeV2Signature(secret, 'POST', url, body),
      'x-hubspot-signature-version': 'v2',
    };
    const req = { method: 'POST', url, rawBody: body, headers };
    expect(verifyHubSpotRequest(req, secret, 0)).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyHubSpotRequest(req, secret, 0, { allowV2: true })).toEqual({ ok: true });
  });
});
