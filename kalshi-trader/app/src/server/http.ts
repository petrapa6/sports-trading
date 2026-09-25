import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** An error with an HTTP status and a stable machine-readable code, returned as `{"error": code}`. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Validates a request body with a (strict) Zod schema; failures become `400 bad_request`. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new HttpError(400, 'bad_request', {
      issues: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
    });
  }
  return result.data;
}

/** Whether the request came from an HTML form (and so expects a page or redirect, not JSON). */
export const isFormPost = (req: FastifyRequest): boolean =>
  (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');

/** Whether a GET/HEAD request comes from a browser navigation (redirect to login instead of 401). */
export function wantsHtml(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = req.url.split('?')[0] ?? '';
  if (path.startsWith('/api/') || path.startsWith('/auth/')) return false;
  return (req.headers.accept ?? '').includes('text/html');
}

export function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
}
