import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPTIONAL_SCOPES, REQUIRED_SCOPES } from '../backend/src/scopes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, any>;
const PLACEHOLDER = 'https://YOUR-BACKEND.example.com';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const metaFiles = walk(join(root, 'src/app'))
  .filter((file) => file.endsWith('-hsmeta.json'))
  .map((file) => relative(root, file));

const EXPECTED_TYPE: Record<string, string> = { app: 'app', cards: 'card', settings: 'settings', 'workflow-actions': 'workflow-action' };

describe('hsproject.json', () => {
  it('names the project, points at src and pins platform version 2026.09', () => {
    expect(readJson('hsproject.json')).toEqual({ name: 'looot-hubspot', srcDir: 'src', platformVersion: '2026.09' });
  });
});

describe('every *-hsmeta.json', () => {
  it('finds the five expected files', () => {
    expect(metaFiles.sort()).toEqual([
      'src/app/app-hsmeta.json',
      'src/app/cards/company-card-hsmeta.json',
      'src/app/cards/contact-card-hsmeta.json',
      'src/app/settings/settings-hsmeta.json',
      'src/app/workflow-actions/enrich-with-looot-hsmeta.json',
    ]);
  });

  it('parses, has uid, type and config, and the type matches its folder', () => {
    const uids = new Set<string>();
    for (const file of metaFiles) {
      const meta = readJson(file);
      expect(typeof meta.uid, file).toBe('string');
      expect(meta.uid, file).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
      expect(uids.has(meta.uid), `${file} duplicates uid ${meta.uid}`).toBe(false);
      uids.add(meta.uid);
      expect(typeof meta.config, file).toBe('object');
      const folder = dirname(file).split('/').pop() ?? '';
      expect(meta.type, file).toBe(EXPECTED_TYPE[folder]);
    }
  });
});

describe('app-hsmeta.json', () => {
  const { config } = readJson('src/app/app-hsmeta.json');

  it('is an OAuth marketplace app with the fields the docs require', () => {
    expect(config.name).toBe('looot');
    expect(config.description.length).toBeGreaterThan(0);
    expect(config.distribution).toBe('marketplace');
    expect(config.auth.type).toBe('oauth');
    expect(config.auth.redirectUrls.length).toBeGreaterThanOrEqual(1);
    for (const url of config.auth.redirectUrls) expect(url).toMatch(/^https:\/\//);
  });

  it('lists the same scopes the backend asks for', () => {
    expect(config.auth.requiredScopes).toEqual(REQUIRED_SCOPES);
    expect(config.auth.optionalScopes).toEqual(OPTIONAL_SCOPES);
  });

  it('allows fetching only from the backend placeholder, over https', () => {
    expect(config.permittedUrls.fetch).toEqual([PLACEHOLDER]);
    expect(config.permittedUrls.iframe).toEqual([]);
  });

  it('uses the one allowed support address', () => {
    expect(config.support.supportEmail).toBe('support@looot.ai');
  });
});

describe('cards', () => {
  for (const file of ['src/app/cards/contact-card-hsmeta.json', 'src/app/cards/company-card-hsmeta.json']) {
    it(`${file} points at a real entrypoint and a supported object type`, () => {
      const { config } = readJson(file);
      expect(config.name.length).toBeGreaterThan(0);
      expect(existsSync(join(root, 'src', config.entrypoint)), config.entrypoint).toBe(true);
      expect(config.objectTypes).toHaveLength(1);
      expect(['CONTACT', 'COMPANY']).toContain(config.objectTypes[0]);
      expect(config.location).toBe('crm.record.tab');
    });
  }

  it('contact card is on contacts and company card on companies', () => {
    expect(readJson('src/app/cards/contact-card-hsmeta.json').config.objectTypes).toEqual(['CONTACT']);
    expect(readJson('src/app/cards/company-card-hsmeta.json').config.objectTypes).toEqual(['COMPANY']);
  });
});

describe('settings', () => {
  it('has an entrypoint that exists', () => {
    const { config } = readJson('src/app/settings/settings-hsmeta.json');
    expect(existsSync(join(root, 'src', config.entrypoint))).toBe(true);
  });
});

describe('workflow action', () => {
  const { config } = readJson('src/app/workflow-actions/enrich-with-looot-hsmeta.json');

  it('calls a route the backend serves, on the placeholder host', () => {
    expect(config.actionUrl).toBe(`${PLACEHOLDER}/workflow/enrich`);
    expect(readFileSync(join(root, 'backend/src/server.ts'), 'utf8')).toContain("'/workflow/enrich'");
  });

  it('has the fields the docs require', () => {
    expect(config.supportedClients).toEqual([{ client: 'WORKFLOWS' }]);
    expect(config.inputFields.length).toBeGreaterThan(0);
    expect(config.labels.en.actionName).toBe('Enrich with looot');
    expect(config.objectTypes).toEqual(['CONTACT', 'COMPANY']);
  });

  it('offers the three lookups the backend handles', () => {
    const lookup = config.inputFields[0].typeDefinition;
    expect(lookup.name).toBe('lookup');
    expect(lookup.options.map((o: { value: string }) => o.value)).toEqual(['find_work_email', 'verify_email', 'enrich_company']);
    const server = readFileSync(join(root, 'backend/src/server.ts'), 'utf8');
    for (const o of lookup.options) expect(server).toContain(`case '${o.value}'`);
  });

  it('labels every input and output field, and outputs the brief names', () => {
    const outputs = config.outputFields.map((f: any) => f.typeDefinition.name);
    expect(outputs).toEqual(['email', 'emailStatus', 'deliverable', 'industry', 'size', 'costUsd', 'provider', 'runId', 'message']);
    for (const name of outputs) expect(config.labels.en.outputFieldLabels[name], name).toBeTruthy();
    for (const f of config.inputFields) expect(config.labels.en.inputFieldLabels[f.typeDefinition.name]).toBeTruthy();
  });
});

describe('placeholders and pins', () => {
  it('uses the same backend host in the card code, the settings code and the app config', () => {
    for (const file of ['src/app/cards/backend.ts', 'src/app/settings/Settings.tsx']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain(`'${PLACEHOLDER}'`);
    }
  });

  it('keeps the card and settings package.json pins equal to the root, with no ranges', () => {
    const rootPkg = readJson('package.json');
    for (const file of ['src/app/cards/package.json', 'src/app/settings/package.json']) {
      const pkg = readJson(file);
      for (const [name, version] of Object.entries<string>({ ...pkg.dependencies, ...pkg.devDependencies })) {
        expect(version, `${file} ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(rootPkg.devDependencies[name], `${file} ${name}`).toBe(version);
      }
    }
    for (const version of Object.values<string>({ ...rootPkg.devDependencies })) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
