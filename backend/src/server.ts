import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type ActionContext,
  type ActionName,
  type ActionResult,
  enrichCompany,
  findWorkEmail,
  verifyEmail,
} from './actions.js';
import type { Config } from './config.js';
import { HubSpotClient, HubSpotError } from './hubspot.js';
import { checkLoootToken, type FetchLike, LoootError } from './looot.js';
import { PriceSource } from './prices.js';
import { verifyHubSpotRequest } from './signature.js';
import type { TokenStore } from './store.js';

export type HttpRequest = { method: string; url: string; headers: Record<string, string | undefined>; body: string };
export type HttpResponse = { status: number; headers: Record<string, string>; body: string };

export type Deps = { config: Config; store: TokenStore; fetchImpl: FetchLike; nowMs: () => number };

const STATE_MAX_AGE_MS = 15 * 60_000;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const json = (status: number, body: unknown): HttpResponse => ({ status, headers: JSON_HEADERS, body: JSON.stringify(body) });
const html = (status: number, text: string): HttpResponse => ({
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta charset="utf-8"><title>looot for HubSpot</title><p>${text}</p>`,
});

const parseJson = (raw: string): Record<string, unknown> => {
  if (raw.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Builds the install state value: a timestamp and an HMAC of it, so no server-side storage is needed. */
export const makeState = (clientSecret: string, nowMs: number): string => {
  const stamp = String(nowMs);
  return `${stamp}.${createHmac('sha256', clientSecret).update(`state:${stamp}`).digest('hex')}`;
};

/** Checks an install state value: right HMAC and under fifteen minutes old. */
export const checkState = (clientSecret: string, state: string | null, nowMs: number): boolean => {
  if (!state) return false;
  const [stamp, mac] = state.split('.');
  if (!stamp || !mac) return false;
  const expected = createHmac('sha256', clientSecret).update(`state:${stamp}`).digest('hex');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  const age = nowMs - Number(stamp);
  return Number.isFinite(age) && age >= 0 && age <= STATE_MAX_AGE_MS;
};

const ACTIONS: Record<ActionName, (ctx: ActionContext, portalId: string, id: string) => Promise<ActionResult>> = {
  'find-work-email': findWorkEmail,
  'verify-email': verifyEmail,
  'enrich-company': enrichCompany,
};

/** Creates the request handler. It takes plain request data and returns plain response data. */
export const createHandler = (deps: Deps) => {
  const { config, store, fetchImpl, nowMs } = deps;
  const hubspot = new HubSpotClient(config, store, fetchImpl, nowMs);
  const prices = new PriceSource(fetchImpl, nowMs);
  const ctx: ActionContext = { hubspot, store, fetchImpl, now: () => new Date(nowMs()), maxCostUsd: config.maxCostUsd };

  const failure = (error: unknown): HttpResponse => {
    if (error instanceof LoootError) return json(200, { ok: false, error: { code: error.code, message: error.message } });
    if (error instanceof HubSpotError) return json(200, { ok: false, error: { code: 'hubspot_error', message: error.message } });
    return json(500, { ok: false, error: { code: 'internal_error', message: 'Something went wrong in the looot backend.' } });
  };

  const runAction = async (name: ActionName, portalId: string, objectId: string): Promise<ActionResult> =>
    ACTIONS[name](ctx, portalId, objectId);

  const workflow = async (body: Record<string, unknown>): Promise<HttpResponse> => {
    const origin = (body.origin ?? {}) as { portalId?: number | string };
    const object = (body.object ?? {}) as { objectId?: number | string; objectType?: string };
    const inputs = (body.inputFields ?? {}) as { lookup?: string };
    const portalId = origin.portalId === undefined ? '' : String(origin.portalId);
    const objectId = object.objectId === undefined ? '' : String(object.objectId);
    const objectType = (object.objectType ?? '').toUpperCase();
    const fail = (message: string): HttpResponse =>
      json(200, { outputFields: { message, hs_execution_state: 'FAIL_CONTINUE' } });
    if (portalId === '' || objectId === '') return json(400, { error: 'origin.portalId and object.objectId are required' });
    try {
      let result: ActionResult;
      switch (inputs.lookup) {
        case 'find_work_email':
          if (objectType !== 'CONTACT') return fail('Find work email runs on contacts.');
          result = await runAction('find-work-email', portalId, objectId);
          break;
        case 'verify_email':
          if (objectType !== 'CONTACT') return fail('Verify email runs on contacts.');
          result = await runAction('verify-email', portalId, objectId);
          break;
        case 'enrich_company': {
          let companyId = objectId;
          if (objectType === 'CONTACT') {
            const associated = await hubspot.firstAssociatedCompanyId(portalId, objectId);
            if (!associated) return fail('The contact has no associated company.');
            companyId = associated;
          } else if (objectType !== 'COMPANY') {
            return fail('Enrich company runs on contacts and companies.');
          }
          result = await runAction('enrich-company', portalId, companyId);
          break;
        }
        default:
          return fail('Choose a lookup: find_work_email, verify_email or enrich_company.');
      }
      return json(200, {
        outputFields: {
          email: result.values.email ?? '',
          emailStatus: result.values.emailStatus ?? '',
          deliverable: result.values.deliverable === null || result.values.deliverable === undefined ? '' : String(result.values.deliverable),
          industry: result.values.industry ?? '',
          size: result.values.size ?? '',
          costUsd: result.run?.costUsd ?? 0,
          provider: result.run?.provider ?? '',
          runId: result.run?.runId ?? '',
          message: result.message,
          hs_execution_state: 'SUCCESS',
        },
      });
    } catch (error) {
      if (error instanceof LoootError || error instanceof HubSpotError) return fail(error.message);
      return json(500, { error: 'internal_error' });
    }
  };

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const method = request.method.toUpperCase();
    const target = new URL(request.url, `${config.publicBaseUrl}/`);
    const path = target.pathname;

    if (method === 'GET' && path === '/health') return json(200, { ok: true });

    if (method === 'GET' && path === '/oauth/install') {
      return { status: 302, headers: { Location: hubspot.installUrl(makeState(config.clientSecret, nowMs())) }, body: '' };
    }
    if (method === 'GET' && path === '/oauth/callback') {
      // An install started from HubSpot's own install URL or Marketplace button carries no state.
      // A state that is present must be one we issued.
      const state = target.searchParams.get('state');
      if (state !== null && !checkState(config.clientSecret, state, nowMs())) {
        return html(400, 'This install link expired or is not valid. Start again from the install link.');
      }
      const code = target.searchParams.get('code');
      if (!code) return html(400, 'HubSpot did not send an authorization code.');
      try {
        const portalId = await hubspot.exchangeCode(code);
        const properties = await hubspot.ensureProperties(portalId);
        const note =
          properties.failed.length > 0
            ? ' The app could not create its custom properties; accept the optional property scopes by reinstalling.'
            : '';
        return html(200, `Installed. In HubSpot open Marketplace, Connected apps, looot, Settings and paste your looot agent token.${note}`);
      } catch (error) {
        return error instanceof HubSpotError ? html(502, 'HubSpot did not accept the install. Try the install link again.') : html(500, 'The install failed.');
      }
    }

    const routes = [
      ['GET', '/api/prices'],
      ['POST', '/api/looot-token'],
      ['POST', '/workflow/enrich'],
    ];
    const actionMatch = /^\/api\/actions\/(find-work-email|verify-email|enrich-company)$/.exec(path);
    const known = routes.some(([m, p]) => m === method && p === path) || (method === 'POST' && actionMatch !== null);
    if (!known) return json(404, { error: 'not_found' });

    const signed = verifyHubSpotRequest(
      {
        method,
        url: `${config.publicBaseUrl}${request.url}`,
        rawBody: request.body,
        headers: request.headers,
      },
      config.clientSecret,
      nowMs(),
      { allowV2: config.allowSignatureV2 },
    );
    if (!signed.ok) return json(401, { error: 'invalid_signature', reason: signed.reason });

    const body = parseJson(request.body);
    if (path === '/workflow/enrich') return workflow(body);

    const portalId = target.searchParams.get('portalId') ?? '';
    if (portalId === '') return json(400, { error: 'portalId is required' });

    if (path === '/api/prices') {
      const report = await prices.get();
      const record = await store.get(portalId);
      return json(200, { ok: true, ...report, hasToken: Boolean(record?.loootToken) });
    }

    if (path === '/api/looot-token') {
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (token === '') return json(400, { ok: false, error: { code: 'missing_token', message: 'Paste a looot agent token.' } });
      const record = await store.get(portalId);
      if (!record) return json(404, { ok: false, error: { code: 'not_installed', message: 'This account has not installed the app.' } });
      try {
        if (!(await checkLoootToken(token, fetchImpl))) {
          return json(200, { ok: false, error: { code: 'unauthorized', message: 'looot did not accept this token.' } });
        }
      } catch (error) {
        return failure(error);
      }
      await store.set({ ...record, loootToken: token });
      return json(200, { ok: true, message: 'Token saved.' });
    }

    if (actionMatch) {
      const name = actionMatch[1] as ActionName;
      if (body.confirm !== true) {
        return json(400, { ok: false, error: { code: 'not_confirmed', message: 'Confirm the lookup and its price first.' } });
      }
      const objectId = body.objectId === undefined ? '' : String(body.objectId);
      if (objectId === '') return json(400, { ok: false, error: { code: 'missing_object', message: 'objectId is required.' } });
      try {
        return json(200, { ok: true, result: await runAction(name, portalId, objectId) });
      } catch (error) {
        return failure(error);
      }
    }
    return json(404, { error: 'not_found' });
  };
};
