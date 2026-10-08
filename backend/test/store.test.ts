import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileTokenStore, MemoryTokenStore, type PortalRecord, type TokenStore } from '../src/store.js';

const record: PortalRecord = { portalId: '1', accessToken: 'a', refreshToken: 'r', expiresAt: 5, loootToken: 'l' };
let dir = '';

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

const contract = (name: string, make: () => Promise<TokenStore>) =>
  describe(name, () => {
    it('returns undefined for an unknown account', async () => {
      expect(await (await make()).get('nope')).toBeUndefined();
    });

    it('stores and replaces a record by account id', async () => {
      const store = await make();
      await store.set(record);
      await store.set({ ...record, accessToken: 'b' });
      await store.set({ ...record, portalId: '2' });
      expect((await store.get('1'))?.accessToken).toBe('b');
      expect((await store.get('2'))?.portalId).toBe('2');
    });
  });

contract('MemoryTokenStore', async () => new MemoryTokenStore());
contract('JsonFileTokenStore', async () => {
  dir = await mkdtemp(join(tmpdir(), 'looot-hubspot-'));
  return new JsonFileTokenStore(join(dir, 'tokens.json'));
});

describe('JsonFileTokenStore file', () => {
  it('writes mode 0600 and survives a new instance', async () => {
    dir = await mkdtemp(join(tmpdir(), 'looot-hubspot-'));
    const path = join(dir, 'nested', 'tokens.json');
    await new JsonFileTokenStore(path).set(record);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await new JsonFileTokenStore(path).get('1'))?.loootToken).toBe('l');
    expect(JSON.parse(await readFile(path, 'utf8'))['1'].refreshToken).toBe('r');
  });
});
