import type { Config } from './config.js';
import type { FetchLike } from './looot.js';
import { OPTIONAL_SCOPES, REQUIRED_SCOPES } from './scopes.js';
import type { PortalRecord, TokenStore } from './store.js';

export const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
export const TOKEN_URL = 'https://api.hubspot.com/oauth/v3/token';
export const API_BASE = 'https://api.hubapi.com';
/** Date-versioned CRM API path segment. Read from the HubSpot docs on 2026-10-09. */
export const API_VERSION = '2026-09';
const REFRESH_MARGIN_MS = 60_000;

/** An error from HubSpot, with the HTTP status. The message never carries a token. */
export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
}

export type CrmObject = { id: string; properties: Record<string, string | null | undefined> };

export type CustomProperty = { object: 'contacts' | 'companies'; name: string; label: string; groupName: string };

/** The three properties this app owns. */
export const CUSTOM_PROPERTIES: CustomProperty[] = [
  { object: 'contacts', name: 'looot_email_status', label: 'looot email status', groupName: 'contactinformation' },
  { object: 'companies', name: 'looot_industry', label: 'looot industry', groupName: 'companyinformation' },
  { object: 'companies', name: 'looot_company_size', label: 'looot company size', groupName: 'companyinformation' },
];

/** Talks to HubSpot for one app: install URL, token exchange and refresh, CRM reads and patches. */
export class HubSpotClient {
  constructor(
    private readonly config: Config,
    private readonly store: TokenStore,
    private readonly fetchImpl: FetchLike,
    private readonly nowMs: () => number,
  ) {}

  /** Builds the HubSpot consent URL for this app. */
  installUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: REQUIRED_SCOPES.join(' '),
      optional_scope: OPTIONAL_SCOPES.join(' '),
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  private async tokenRequest(form: Record<string, string>): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    hub_id?: number;
  }> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...form }).toString(),
    });
    if (!response.ok) throw new HubSpotError(`HubSpot refused the token request (HTTP ${response.status}).`, response.status);
    return (await response.json()) as { access_token: string; refresh_token: string; expires_in: number; hub_id?: number };
  }

  /** Swaps the OAuth code for tokens and saves them under the account id HubSpot returns. */
  async exchangeCode(code: string): Promise<string> {
    const token = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri });
    if (token.hub_id === undefined) throw new HubSpotError('HubSpot did not return an account id.', 502);
    const portalId = String(token.hub_id);
    const existing = await this.store.get(portalId);
    await this.store.set({
      ...existing,
      portalId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: this.nowMs() + token.expires_in * 1000,
    });
    return portalId;
  }

  private async refresh(record: PortalRecord): Promise<PortalRecord> {
    const token = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: record.refreshToken });
    const next: PortalRecord = {
      ...record,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? record.refreshToken,
      expiresAt: this.nowMs() + token.expires_in * 1000,
    };
    await this.store.set(next);
    return next;
  }

  /** Returns a record whose access token is valid for at least a minute, refreshing when needed. */
  async activeRecord(portalId: string, forceRefresh = false): Promise<PortalRecord> {
    const record = await this.store.get(portalId);
    if (!record) throw new HubSpotError('This HubSpot account has not installed the app.', 404);
    if (forceRefresh || record.expiresAt - this.nowMs() < REFRESH_MARGIN_MS) return this.refresh(record);
    return record;
  }

  private async call(portalId: string, method: string, path: string, body?: unknown): Promise<Response> {
    const send = async (record: PortalRecord) =>
      this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${record.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let response = await send(await this.activeRecord(portalId));
    if (response.status === 401) response = await send(await this.activeRecord(portalId, true));
    return response;
  }

  /** Reads one contact or company with the listed properties. */
  async getObject(portalId: string, object: 'contacts' | 'companies', id: string, properties: string[]): Promise<CrmObject> {
    const query = new URLSearchParams({ properties: properties.join(',') });
    const response = await this.call(portalId, 'GET', `/crm/objects/${API_VERSION}/${object}/${encodeURIComponent(id)}?${query.toString()}`);
    if (!response.ok) throw new HubSpotError(`HubSpot could not read the ${object.slice(0, -1)} (HTTP ${response.status}).`, response.status);
    return (await response.json()) as CrmObject;
  }

  /** Returns the id of the first company associated with a contact, or null. */
  async firstAssociatedCompanyId(portalId: string, contactId: string): Promise<string | null> {
    const response = await this.call(portalId, 'GET', `/crm/objects/${API_VERSION}/contacts/${encodeURIComponent(contactId)}/associations/companies`);
    if (!response.ok) return null;
    const body = (await response.json()) as { results?: { toObjectId?: number | string; id?: string }[] };
    const first = body.results?.[0];
    const id = first?.toObjectId ?? first?.id;
    return id === undefined ? null : String(id);
  }

  /** Patches properties on a contact or company. */
  async patchObject(portalId: string, object: 'contacts' | 'companies', id: string, properties: Record<string, string>): Promise<void> {
    const response = await this.call(portalId, 'PATCH', `/crm/objects/${API_VERSION}/${object}/${encodeURIComponent(id)}`, { properties });
    if (!response.ok) throw new HubSpotError(`HubSpot refused the update (HTTP ${response.status}).`, response.status);
  }

  /** Creates the app-owned custom properties. A property that exists already counts as done. */
  async ensureProperties(portalId: string): Promise<{ created: string[]; failed: string[] }> {
    const created: string[] = [];
    const failed: string[] = [];
    for (const property of CUSTOM_PROPERTIES) {
      const response = await this.call(portalId, 'POST', `/crm/properties/${API_VERSION}/${property.object}`, {
        groupName: property.groupName,
        name: property.name,
        label: property.label,
        type: 'string',
        fieldType: 'text',
      });
      if (response.ok || response.status === 409) created.push(property.name);
      else failed.push(property.name);
    }
    return { created, failed };
  }
}
