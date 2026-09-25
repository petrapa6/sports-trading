import type { Repositories } from '../db/repositories.js';
import type { RequestClass } from './requestClass.js';

/** Who did something and from where; `channel` is the request class (null for `system`). */
export interface AuditContext {
  actor: string;
  ip?: string | null;
  channel?: RequestClass | null;
}

export interface AuditEntry {
  action: string;
  /** `live` / `dry_run` for trade-related rows; null otherwise. */
  mode?: 'live' | 'dry_run' | null;
  entity?: string | null;
  entityId?: string | null;
  detail?: Record<string, unknown> | null;
}

/** Actor string for a user (`user:<name>`), per the `audit_log.actor` convention in §7. */
export const userActor = (username: string): string => `user:${username}`;

/**
 * Appends one row to `audit_log` (SPEC.md §10: every money- or security-related action). Rows are
 * never updated or deleted by the app.
 */
export function writeAudit(repos: Repositories, now: number, ctx: AuditContext, entry: AuditEntry): void {
  repos.auditLog.insert({
    at: new Date(now).toISOString(),
    actor: ctx.actor,
    ip: ctx.ip ?? null,
    channel: ctx.channel ?? null,
    mode: entry.mode ?? null,
    action: entry.action,
    entity: entry.entity ?? null,
    entity_id: entry.entityId ?? null,
    detail: entry.detail ? JSON.stringify(entry.detail) : null,
  });
}
