import { createHash, createPublicKey } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http.js';

/**
 * SHA-256 of the SPKI public key in PEM form derived from a private key, i.e. the same value as
 * `openssl pkey -in key.pem -pubout | sha256sum`. Safe to show: it identifies the key without
 * revealing it.
 */
export function publicKeyFingerprint(privateKeyPem: string): string {
  const spki = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  return createHash('sha256').update(spki).digest('hex');
}

export interface DevRouteOptions {
  /** `publicKeyFingerprint` of the loaded Kalshi key; `undefined` when no key is loaded. */
  privateKeyFingerprint: string | undefined;
}

/**
 * Development-only diagnostics. `buildApp` registers them only when `NODE_ENV=development`, and
 * they answer only class `dev` (loopback); everything else gets the ordinary 404.
 *
 * `GET /api/dev/key-fingerprint` proves which private key the process loaded (T05: the key handed
 * over on fd 3 is the one in `options.json`) without the key itself ever leaving memory.
 */
export function registerDevRoutes(app: FastifyInstance, options: DevRouteOptions): void {
  app.get('/api/dev/key-fingerprint', { config: { public: true } }, async (req) => {
    if (req.client.class !== 'dev') throw new HttpError(404, 'not_found');
    return {
      loaded: options.privateKeyFingerprint !== undefined,
      sha256: options.privateKeyFingerprint ?? null,
    };
  });
}
