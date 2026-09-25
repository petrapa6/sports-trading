import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The session/encryption secret (SPEC.md §10 Secrets): 32 random bytes in `${DATA_DIR}/secret.key`
 * (mode 600), generated on first start. Every key the app uses is derived from it with HKDF, so
 * deleting the file logs everyone out and makes encrypted settings unreadable.
 */
export const SECRET_KEY_FILE = 'secret.key';
const SECRET_BYTES = 32;

export class SecretKeyError extends Error {
  override name = 'SecretKeyError';
}

export interface LoadedSecret {
  key: Buffer;
  path: string;
  /** True when the file did not exist and was generated now. */
  generated: boolean;
}

/** Reads `${dataDir}/secret.key`, generating it (mode 600) when missing. */
export function loadOrCreateSecretKey(dataDir: string): LoadedSecret {
  const path = join(dataDir, SECRET_KEY_FILE);
  mkdirSync(dirname(path), { recursive: true });
  let generated = false;
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, randomBytes(SECRET_BYTES));
    } finally {
      closeSync(fd);
    }
    generated = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Tighten the mode even if a umask or an older file left it wider.
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== SECRET_BYTES) {
    throw new SecretKeyError(
      `${path} must contain exactly ${SECRET_BYTES} bytes (found ${key.length}); delete it to generate a new one`,
    );
  }
  return { key, path, generated };
}

export type KeyPurpose = 'cookie' | 'csrf' | 'settings';

/** Derives a 32-byte key for one purpose from the secret with HKDF-SHA256. */
export function deriveKey(secret: Buffer, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `kalshi-trader/${purpose}/v1`, 32));
}

const PREFIX = 'v1:';

/** Encrypts a setting value with AES-256-GCM under a key derived from the secret. Output: `v1:<base64url>`. */
export function encryptSetting(plaintext: string, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, 'settings'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Decrypts a value from `encryptSetting`; throws when the key is wrong or the value was tampered with. */
export function decryptSetting(value: string, secret: Buffer): string {
  if (!value.startsWith(PREFIX)) throw new SecretKeyError('encrypted setting has an unknown format');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
  if (raw.length < 28) throw new SecretKeyError('encrypted setting is truncated');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, 'settings'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
