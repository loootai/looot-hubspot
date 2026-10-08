import { CATALOG_URL, type FetchLike } from './looot.js';

/** Cheapest provider price per call for each job, as read from the public catalog. */
export type Prices = { findWorkEmail: number; verifyEmail: number; enrichCompany: number };
export type PriceReport = { prices: Prices; asOf: string; source: 'live' | 'fallback' };

/** Prices read from the public catalog on 2026-10-09. Shown only when the live read fails. */
export const FALLBACK_PRICES: PriceReport = {
  prices: { findWorkEmail: 0.003598, verifyEmail: 0.00145, enrichCompany: 0.0019 },
  asOf: '2026-10-09',
  source: 'fallback',
};

const CACHE_MS = 5 * 60_000;
const JOB_IDS = { findWorkEmail: 'people.email.find', verifyEmail: 'people.email.verify', enrichCompany: 'company.enrich' } as const;

type Overview = { categories?: { platforms?: { jobs?: { id?: string; cheapestPerCall?: number | null }[] }[] }[] };

/** Pulls the three job prices out of a catalog overview, or null when one is missing. */
export const parseOverview = (overview: Overview): Prices | null => {
  const found = new Map<string, number>();
  for (const category of overview.categories ?? []) {
    for (const platform of category.platforms ?? []) {
      for (const job of platform.jobs ?? []) {
        if (job.id && typeof job.cheapestPerCall === 'number') found.set(job.id, job.cheapestPerCall);
      }
    }
  }
  const prices = {} as Prices;
  for (const [key, id] of Object.entries(JOB_IDS) as [keyof Prices, string][]) {
    const price = found.get(id);
    if (price === undefined) return null;
    prices[key] = price;
  }
  return prices;
};

/** Reads job prices from the public catalog and keeps them for five minutes. */
export class PriceSource {
  private cached: { at: number; report: PriceReport } | null = null;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly nowMs: () => number,
  ) {}

  async get(): Promise<PriceReport> {
    const now = this.nowMs();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.report;
    try {
      const response = await this.fetchImpl(CATALOG_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
      const prices = parseOverview((await response.json()) as Overview);
      if (!prices) throw new Error('catalog is missing a job');
      const report: PriceReport = { prices, asOf: new Date(now).toISOString().slice(0, 10), source: 'live' };
      this.cached = { at: now, report };
      return report;
    } catch {
      return FALLBACK_PRICES;
    }
  }
}
