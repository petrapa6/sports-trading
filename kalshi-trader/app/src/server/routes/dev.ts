import { createHash, createPublicKey } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyReplayLine, ReplayLineSchema, type ReplayContext } from '../../core/replay.js';
import { HttpError, parseBody } from '../http.js';

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

export interface ReplayRouteOptions {
  context: ReplayContext;
  /** e2e only (`KST_E2E=1`, never production): also accept loopback peers, which are not class `dev` there. */
  allowLoopback: boolean;
  now?: () => number;
}

const ReplayBody = z.object({ line: ReplayLineSchema, reset: z.boolean().optional() }).strict();

const isLoopback = (ip: string) => ip === '::1' || ip.startsWith('127.');

/**
 * `POST /api/dev/replay` (T07, development only): plays one recorded feed line through the adapter
 * conversion and the tracker, observed "now". `npm run replay` posts a file line by line at the chosen
 * speed; `reset: true` (first line of each game) starts the game over and schedules it now. Answers
 * only class `dev` (or, in the e2e server, a loopback peer); everything else gets the ordinary 404.
 */
export function registerReplayRoute(app: FastifyInstance, options: ReplayRouteOptions): void {
  const now = options.now ?? Date.now;
  app.post('/api/dev/replay', { config: { public: true } }, async (req) => {
    const c = req.client;
    const allowed = c.class === 'dev' || (options.allowLoopback && c.class === 'other' && isLoopback(c.peer));
    if (!allowed) throw new HttpError(404, 'not_found');
    const body = parseBody(ReplayBody, req.body);
    const at = now();
    try {
      const state = applyReplayLine(options.context, body.line, {
        observedAt: at,
        ...(body.reset ? { reset: true, scheduledAt: at } : {}),
      });
      return { ok: true, state: state ?? null };
    } catch (err) {
      throw new HttpError(400, 'replay_rejected', { message: (err as Error).message });
    }
  });
}
