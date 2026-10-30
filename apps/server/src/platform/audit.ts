import type { AuditLog } from '../shared-kernel/index.ts';
import type { Sql } from './db.ts';

export class PgAuditLog implements AuditLog {
  constructor(private readonly sql: Sql) {}

  async record(entry: {
    actorId: string | null;
    action: string;
    target?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`insert into platform.audit_log (actor_id, action, target, meta)
      values (${entry.actorId}, ${entry.action}, ${entry.target ?? null},
        ${JSON.stringify(entry.meta ?? {})}::text::jsonb)`;
  }
}
