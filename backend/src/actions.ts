import { HubSpotClient, HubSpotError } from './hubspot.js';
import {
  cleanInput,
  type FetchLike,
  JOB_ENRICH_COMPANY,
  JOB_FIND_WORK_EMAIL,
  JOB_VERIFY_EMAIL,
  LoootError,
  type LoootRunSummary,
  readField,
  runLoootJob,
  summarizeRun,
} from './looot.js';
import type { TokenStore } from './store.js';

export type ActionContext = {
  hubspot: HubSpotClient;
  store: TokenStore;
  fetchImpl: FetchLike;
  now: () => Date;
  maxCostUsd: number | null;
};

export type ActionName = 'find-work-email' | 'verify-email' | 'enrich-company';

/** What an action returns to the card and to the workflow endpoint. */
export type ActionResult = {
  action: ActionName;
  /** True when looot returned the value the action looks for. False when nothing was called or nothing was found. */
  found: boolean;
  /** True when the action stopped before calling looot, so nothing was charged. */
  skipped: boolean;
  message: string;
  run: LoootRunSummary | null;
  values: {
    email?: string | null;
    emailStatus?: string | null;
    deliverable?: boolean | null;
    industry?: string | null;
    size?: string | null;
    companyName?: string | null;
    companyDomain?: string | null;
  };
  written: { property: string; value: string }[];
  notWritten: { property: string; reason: string }[];
};

const NO_RUN = null;

const requireToken = async (ctx: ActionContext, portalId: string): Promise<string> => {
  const record = await ctx.store.get(portalId);
  if (!record?.loootToken) throw new LoootError('Add your looot agent token in the app settings first.', 'missing_token');
  return record.loootToken;
};

const runOptions = (ctx: ActionContext, token: string) => ({
  token,
  maxCostUsd: ctx.maxCostUsd,
  fetchImpl: ctx.fetchImpl,
  now: ctx.now(),
});

/** Turns a website value into a bare domain, or an empty string. */
export const toDomain = (value: string | null | undefined): string => {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '') return '';
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const isEmpty = (value: string | null | undefined): boolean => (value ?? '').trim() === '';

/** Patches one property at a time so a missing custom property cannot block the others. */
const writeOne = async (
  ctx: ActionContext,
  portalId: string,
  object: 'contacts' | 'companies',
  id: string,
  property: string,
  value: string,
  result: ActionResult,
): Promise<void> => {
  try {
    await ctx.hubspot.patchObject(portalId, object, id, { [property]: value });
    result.written.push({ property, value });
  } catch (error) {
    const reason =
      error instanceof HubSpotError && error.status === 400
        ? 'the property does not exist yet; accept the optional property scopes and reinstall'
        : error instanceof Error
          ? error.message
          : 'unknown error';
    result.notWritten.push({ property, reason });
  }
};

const emptyResult = (action: ActionName, message: string, skipped: boolean): ActionResult => ({
  action,
  found: false,
  skipped,
  message,
  run: NO_RUN,
  values: {},
  written: [],
  notWritten: [],
});

/** Finds a contact's work email through looot and writes it to the contact when the email is empty. */
export const findWorkEmail = async (ctx: ActionContext, portalId: string, contactId: string): Promise<ActionResult> => {
  const token = await requireToken(ctx, portalId);
  const contact = await ctx.hubspot.getObject(portalId, 'contacts', contactId, [
    'firstname',
    'lastname',
    'email',
    'company',
    'website',
    'hs_linkedin_url',
  ]);
  const existing = contact.properties.email;
  if (!isEmpty(existing)) {
    const result = emptyResult('find-work-email', 'This contact already has an email. Nothing was called or charged.', true);
    result.values.email = existing ?? null;
    return result;
  }
  let domain = toDomain(contact.properties.website);
  let companyName = contact.properties.company ?? '';
  if (domain === '' && isEmpty(companyName)) {
    const companyId = await ctx.hubspot.firstAssociatedCompanyId(portalId, contactId);
    if (companyId) {
      const company = await ctx.hubspot.getObject(portalId, 'companies', companyId, ['name', 'domain']);
      domain = toDomain(company.properties.domain);
      companyName = company.properties.name ?? '';
    }
  }
  const input = cleanInput({
    first_name: contact.properties.firstname,
    last_name: contact.properties.lastname,
    domain,
    company: companyName,
    linkedin_url: contact.properties.hs_linkedin_url,
  });
  const hasName = (Boolean(input.first_name) && Boolean(input.last_name)) || Boolean(input.linkedin_url);
  if (!hasName) throw new LoootError('The contact needs a first and last name, or a LinkedIn URL.', 'missing_person');
  if (!input.domain && !input.company && !input.linkedin_url) {
    throw new LoootError('The contact needs a company name or website, or a LinkedIn URL.', 'missing_company');
  }
  const run = await runLoootJob(JOB_FIND_WORK_EMAIL, input, runOptions(ctx, token));
  const email = readField(run, 'email');
  const result = emptyResult(
    'find-work-email',
    email ? `Found ${email}.` : 'looot found no email for this contact. Check the name and company, then try again.',
    false,
  );
  result.found = email !== null;
  result.run = summarizeRun(run);
  result.values = { email };
  if (email) await writeOne(ctx, portalId, 'contacts', contactId, 'email', email, result);
  return result;
};

/** Checks whether a contact's email is deliverable and writes the status to looot_email_status when empty. */
export const verifyEmail = async (ctx: ActionContext, portalId: string, contactId: string): Promise<ActionResult> => {
  const token = await requireToken(ctx, portalId);
  const contact = await ctx.hubspot.getObject(portalId, 'contacts', contactId, ['email', 'looot_email_status']);
  const email = (contact.properties.email ?? '').trim();
  if (email === '') throw new LoootError('The contact has no email to verify.', 'missing_email');
  const run = await runLoootJob(JOB_VERIFY_EMAIL, { email }, runOptions(ctx, token));
  const status = readField(run, 'status');
  const deliverableRaw = run.normalized?.fields?.deliverable;
  const deliverable = typeof deliverableRaw === 'boolean' ? deliverableRaw : null;
  const result = emptyResult(
    'verify-email',
    status ? `${email} is ${status}.` : 'looot returned no status for this email.',
    false,
  );
  result.found = status !== null || deliverable !== null;
  result.run = summarizeRun(run);
  result.values = { email: readField(run, 'email') ?? email, emailStatus: status, deliverable };
  if (status) {
    if (isEmpty(contact.properties.looot_email_status)) {
      await writeOne(ctx, portalId, 'contacts', contactId, 'looot_email_status', status, result);
    } else {
      result.notWritten.push({ property: 'looot_email_status', reason: 'already has a value; clear it to write a new one' });
    }
  }
  return result;
};

/** Gets a company's industry and size through looot and writes the empty ones to the company. */
export const enrichCompany = async (ctx: ActionContext, portalId: string, companyId: string): Promise<ActionResult> => {
  const token = await requireToken(ctx, portalId);
  const company = await ctx.hubspot.getObject(portalId, 'companies', companyId, [
    'name',
    'domain',
    'looot_industry',
    'looot_company_size',
  ]);
  if (!isEmpty(company.properties.looot_industry) && !isEmpty(company.properties.looot_company_size)) {
    return emptyResult('enrich-company', 'Industry and size are already filled. Nothing was called or charged.', true);
  }
  const input = cleanInput({ domain: toDomain(company.properties.domain), name: company.properties.name });
  if (!input.domain && !input.name) throw new LoootError('The company needs a domain or a name.', 'missing_company');
  const run = await runLoootJob(JOB_ENRICH_COMPANY, input, runOptions(ctx, token));
  const industry = readField(run, 'industry');
  const size = readField(run, 'size');
  const result = emptyResult(
    'enrich-company',
    industry || size ? 'Company enriched.' : 'looot found no industry or size for this company.',
    false,
  );
  result.found = industry !== null || size !== null;
  result.run = summarizeRun(run);
  result.values = { industry, size, companyName: readField(run, 'name'), companyDomain: readField(run, 'domain') };
  const fills: [string, string | null][] = [
    ['looot_industry', industry],
    ['looot_company_size', size],
  ];
  for (const [property, value] of fills) {
    if (value === null) continue;
    if (isEmpty(company.properties[property])) await writeOne(ctx, portalId, 'companies', companyId, property, value, result);
    else result.notWritten.push({ property, reason: 'already has a value' });
  }
  return result;
};
