import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { checkAddonConfig, portFromRunSh } from '../../scripts/check-addon-config.js';
import { toAddonOptions } from '../../scripts/compose-options.js';
import { loadConfig } from '../../src/config.js';

const APP = resolve(import.meta.dirname, '../..');
const ADDON = resolve(APP, '..');
const ROOT = resolve(ADDON, '..');
const read = (p: string) => readFileSync(p, 'utf8');

const configYaml = read(join(ADDON, 'config.yaml'));
const runSh = read(join(ADDON, 'run.sh'));
const packageVersion = (JSON.parse(read(join(APP, 'package.json'))) as { version: string }).version;
const inputs = { configYaml, packageVersion, port: portFromRunSh(runSh) };

/** config.yaml with `edit` applied to its parsed form. */
function edited(edit: (doc: Record<string, unknown>) => void): string {
  const doc = parse(configYaml) as Record<string, unknown>;
  edit(doc);
  return stringify(doc);
}
const keysOf = (yaml: string) => checkAddonConfig({ ...inputs, configYaml: yaml }).map((p) => p.key);

describe('check:addon (scripts/check-addon-config.ts)', () => {
  it('accepts the committed config.yaml', () => {
    expect(inputs.port).toBe(8099);
    expect(checkAddonConfig(inputs)).toEqual([]);
  });

  it('names the key for each violation', () => {
    expect(keysOf(edited((d) => delete d['slug']))).toEqual(['slug']);
    expect(keysOf(edited((d) => ((d['options'] as Record<string, unknown>)['extra'] = 1)))).toEqual([
      'options.extra',
    ]);
    expect(keysOf(edited((d) => ((d['schema'] as Record<string, unknown>)['extra'] = 'str')))).toEqual([
      'schema.extra',
    ]);
    expect(keysOf(edited((d) => ((d['ports'] as Record<string, unknown>)['8099/tcp'] = 8099)))).toEqual([
      'ports.8099/tcp',
    ]);
    expect(keysOf(edited((d) => (d['ingress_port'] = 8100)))).toEqual(['ingress_port']);
    expect(keysOf(edited((d) => (d['init'] = false)))).toEqual(['init']);
    expect(keysOf(edited((d) => (d['map'] = ['share:rw'])))).toEqual(['map']);
    expect(keysOf(edited((d) => (d['map'] = [])))).toEqual([]);
    for (const key of ['host_network', 'full_access', 'hassio_api']) {
      expect(keysOf(edited((d) => (d[key] = true)))).toEqual([key]);
    }
    expect(keysOf(edited((d) => (d['privileged'] = ['NET_ADMIN'])))).toEqual(['privileged']);
    expect(keysOf(edited((d) => (d['version'] = '9.9.9')))).toEqual(['version']);
    expect(keysOf('name: [unclosed')).toEqual(['config.yaml']);
  });

  it('allows optional ("?") schema keys to be absent from options', () => {
    const doc = parse(configYaml) as { schema: Record<string, string>; options: Record<string, unknown> };
    expect(doc.schema['timezone']).toBe('str?');
    expect('timezone' in doc.options).toBe(false);
  });
});

describe('config.yaml matches SPEC.md §11 field for field', () => {
  it('parses to the same document as the §11 block', () => {
    const spec = read(join(ROOT, 'SPEC.md'));
    const block = /### `config\.yaml`\n\n```yaml\n([\s\S]*?)```/.exec(spec)?.[1];
    expect(block).toBeDefined();
    expect(parse(configYaml)).toEqual(parse(block ?? ''));
  });

  it('carries the same version as package.json and the Dockerfile label', () => {
    expect((parse(configYaml) as { version: string }).version).toBe(packageVersion);
    expect(read(join(ADDON, 'Dockerfile'))).toContain(`io.hass.version="${packageVersion}"`);
  });

  it('repository.yaml has the three reference-app keys', () => {
    expect(parse(read(join(ROOT, 'repository.yaml')))).toEqual({
      name: 'Kalshi Sports Trader',
      url: 'https://github.com/petrapa6/sports-trading',
      maintainer: 'Pavel',
    });
  });
});

describe('translations/en.yaml and DOCS.md', () => {
  it('has a name and a description for every option', () => {
    const schema = (parse(configYaml) as { schema: Record<string, unknown> }).schema;
    const tr = parse(read(join(ADDON, 'translations/en.yaml'))) as {
      configuration: Record<string, { name?: string; description?: string }>;
    };
    for (const key of Object.keys(schema)) {
      expect(tr.configuration[key]?.name, key).toBeTruthy();
      expect(tr.configuration[key]?.description, key).toBeTruthy();
    }
  });

  it('DOCS.md has a heading for every T05 scope item and documents every option', () => {
    const docs = read(join(ADDON, 'DOCS.md'));
    const headings = [...docs.matchAll(/^#{2,3} (.+)$/gm)].map((m) => (m[1] ?? '').toLowerCase());
    for (const topic of [
      'installation',
      'kalshi api key',
      'configuration',
      'dedicated subaccount',
      'cloudflared',
      'cloudflare access',
      'data storage',
      'backup',
    ]) {
      expect(
        headings.some((h) => h.includes(topic)),
        topic,
      ).toBe(true);
    }
    expect(docs).toContain('base64 -w0 key.pem');
    expect(docs).toMatch(/upgrade/i);
    expect(docs).toMatch(/backup password/i);
    for (const key of Object.keys((parse(configYaml) as { schema: object }).schema)) {
      expect(docs, key).toContain(`| \`${key}\` |`);
    }
  });
});

describe('compose:options (scripts/compose-options.ts)', () => {
  it('maps the local configuration to the app options, the key as one base64 line', () => {
    const { config } = loadConfig({
      env: {
        CONFIG_LOCAL_PATH: '/nonexistent/config.local.json',
        KALSHI_KEY_ID: 'kid',
        KALSHI_SUBACCOUNT: '3',
        TZ: 'Europe/Prague',
      },
      argv: [],
    });
    const withKey = { ...config, kalshiPrivateKeyPath: '/k.pem' };
    const options = toAddonOptions(withKey, () => Buffer.from('-----PEM-----\nline\n'));
    expect(options).toEqual({
      kalshi_env: 'demo',
      kalshi_key_id: 'kid',
      kalshi_private_key_b64: Buffer.from('-----PEM-----\nline\n').toString('base64'),
      kalshi_subaccount: 3,
      allow_live_orders: false,
      log_level: 'info',
      trusted_proxies: '172.30.32.0/23',
      timezone: 'Europe/Prague',
    });
    expect(String(options['kalshi_private_key_b64'])).not.toContain('\n');
    const schema = (parse(configYaml) as { schema: Record<string, unknown> }).schema;
    expect(Object.keys(options).sort()).toEqual(Object.keys(schema).sort());
  });
});
