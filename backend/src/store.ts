import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What the backend keeps for one HubSpot account. Secrets: never log this object. */
export type PortalRecord = {
  portalId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token stops working. */
  expiresAt: number;
  /** The customer's looot agent token. Absent until they paste it in the settings page. */
  loootToken?: string;
};

/**
 * Where portal records live. The two classes below are for tests and local use only.
 * Production needs a store that encrypts these values at rest.
 */
export interface TokenStore {
  get(portalId: string): Promise<PortalRecord | undefined>;
  set(record: PortalRecord): Promise<void>;
}

/** Keeps records in memory. Lost on restart. */
export class MemoryTokenStore implements TokenStore {
  private readonly records = new Map<string, PortalRecord>();

  async get(portalId: string): Promise<PortalRecord | undefined> {
    const record = this.records.get(portalId);
    return record ? { ...record } : undefined;
  }

  async set(record: PortalRecord): Promise<void> {
    this.records.set(record.portalId, { ...record });
  }
}

/** Keeps records in one JSON file with mode 0600. Plain text on disk: local use only. */
export class JsonFileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  private async readAll(): Promise<Record<string, PortalRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, PortalRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async get(portalId: string): Promise<PortalRecord | undefined> {
    return (await this.readAll())[portalId];
  }

  async set(record: PortalRecord): Promise<void> {
    const all = await this.readAll();
    all[record.portalId] = record;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }
}
