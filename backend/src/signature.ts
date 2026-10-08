import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** HubSpot rejects v3 signatures older than five minutes; so do we. */
export const MAX_SIGNATURE_AGE_MS = 300_000;

const DECODE_MAP: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

export type SignedRequest = {
  method: string;
  /** Absolute URL as HubSpot called it, including the query string. */
  url: string;
  /** Raw body text, exactly as received. Empty string when there is none. */
  rawBody: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
};

export type SignatureResult = { ok: true } | { ok: false; reason: string };

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Drops the fragment and decodes the characters HubSpot decodes in the query string only. */
export const normalizeUri = (url: string): string => {
  const withoutFragment = url.split('#')[0] ?? url;
  const queryAt = withoutFragment.indexOf('?');
  if (queryAt === -1) return withoutFragment;
  const head = withoutFragment.slice(0, queryAt + 1);
  const query = withoutFragment
    .slice(queryAt + 1)
    .replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (match) => DECODE_MAP[match.toUpperCase()] ?? match);
  return head + query;
};

/** Computes the v3 signature: base64 of HMAC SHA-256 over method, uri, body and timestamp. */
export const computeV3Signature = (clientSecret: string, method: string, url: string, rawBody: string, timestamp: string): string =>
  createHmac('sha256', clientSecret)
    .update(`${method.toUpperCase()}${normalizeUri(url)}${rawBody}${timestamp}`, 'utf8')
    .digest('base64');

/** Computes the older v2 signature: hex SHA-256 over secret, method, uri and body. */
export const computeV2Signature = (clientSecret: string, method: string, url: string, rawBody: string): string =>
  createHash('sha256').update(`${clientSecret}${method.toUpperCase()}${url}${rawBody}`, 'utf8').digest('hex');

/**
 * Checks that a request came from HubSpot. Needs a v3 signature and a timestamp under five minutes
 * old. The v2 check only runs when allowV2 is true, because v2 has no timestamp and can be replayed.
 */
export const verifyHubSpotRequest = (
  request: SignedRequest,
  clientSecret: string,
  nowMs: number,
  options: { allowV2?: boolean } = {},
): SignatureResult => {
  const v3 = request.headers['x-hubspot-signature-v3'];
  if (v3) {
    const timestamp = request.headers['x-hubspot-request-timestamp'];
    const timestampMs = Number(timestamp);
    if (!timestamp || !Number.isFinite(timestampMs)) return { ok: false, reason: 'missing_timestamp' };
    if (Math.abs(nowMs - timestampMs) > MAX_SIGNATURE_AGE_MS) return { ok: false, reason: 'stale_timestamp' };
    const expected = computeV3Signature(clientSecret, request.method, request.url, request.rawBody, timestamp);
    return safeEqual(expected, v3) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  }
  const v2 = request.headers['x-hubspot-signature'];
  if (v2 && options.allowV2 === true && request.headers['x-hubspot-signature-version'] === 'v2') {
    const expected = computeV2Signature(clientSecret, request.method, request.url, request.rawBody);
    return safeEqual(expected, v2) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  }
  return { ok: false, reason: 'missing_signature' };
};
