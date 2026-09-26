/**
 * Prepares the e2e Kalshi credentials before the e2e server starts: a fresh RSA key (never committed)
 * and a `config.local.json` pointing at it, both under the git-ignored `.local/e2e/`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '../../.local/e2e');
mkdirSync(dir, { recursive: true });
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
writeFileSync(resolve(dir, 'kalshi-e2e.pem'), pem, { mode: 0o600 });
writeFileSync(
  resolve(dir, 'config.local.json'),
  `${JSON.stringify({ kalshiKeyId: 'e2e-key-id', kalshiPrivateKeyPath: resolve(dir, 'kalshi-e2e.pem') }, null, 2)}\n`,
);
