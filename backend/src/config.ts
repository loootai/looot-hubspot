/** Settings the backend reads from the environment. */
export type Config = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicBaseUrl: string;
  maxCostUsd: number | null;
  allowSignatureV2: boolean;
};

/** Reads the backend settings and throws a plain message naming each missing variable. */
export const readConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const missing = ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_REDIRECT_URI', 'PUBLIC_BASE_URL'].filter(
    (name) => (env[name] ?? '').trim() === '',
  );
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const cap = Number(env.LOOOT_MAX_COST_USD);
  return {
    clientId: (env.HUBSPOT_CLIENT_ID ?? '').trim(),
    clientSecret: (env.HUBSPOT_CLIENT_SECRET ?? '').trim(),
    redirectUri: (env.HUBSPOT_REDIRECT_URI ?? '').trim(),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    maxCostUsd: Number.isFinite(cap) && cap > 0 ? cap : null,
    allowSignatureV2: (env.HUBSPOT_ALLOW_SIGNATURE_V2 ?? '').trim() === 'true',
  };
};
