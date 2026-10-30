import { type DomainEvent, errorLabel } from '../shared-kernel/index.ts';
import type { Sql, Tx } from './db.ts';

/** After this many failed deliveries an event is left alone (see the recovery sweep). */
export const MAX_ATTEMPTS = 10;
// A claimed row stays invisible to other claimers for this long (lease); markFailed replaces it with backoff.
const LEASE_SECONDS = 60;

export interface OutboxRow {
  id: bigint;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function appendOutbox(tx: Tx, events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  const rows = JSON.stringify(events.map((e) => ({ type: e.type, payload: e.payload })));
  await tx`insert into platform.outbox (type, payload)
    select type, payload from jsonb_to_recordset(${rows}::text::jsonb) as x(type text, payload jsonb)`;
}

interface ClaimedRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function claimOutbox(sql: Sql, limit: number): Promise<OutboxRow[]> {
  const rows = await sql.begin(async (tx): Promise<ClaimedRow[]> => {
    const picked = await tx<{ id: string }[]>`
      select id from platform.outbox
      where processed_at is null and next_attempt_at <= now() and attempts < ${MAX_ATTEMPTS}
      order by id
      limit ${limit}
      for update skip locked`;
    if (picked.length === 0) return [];
    return tx<ClaimedRow[]>`
      update platform.outbox
      set attempts = attempts + 1,
          next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where id = any(${picked.map((r) => r.id)}::bigint[])
      returning id, type, payload, attempts`;
  });
  return rows
    .map((r) => ({ id: BigInt(r.id), type: r.type, payload: r.payload, attempts: r.attempts }))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function markProcessed(sql: Sql, id: bigint): Promise<void> {
  await sql`update platform.outbox set processed_at = now(), last_error = null
    where id = ${id.toString()}`;
}

/**
 * Schedules a retry with backoff. `last_error` gets only a content-free label (the error's
 * name, plus a short code such as a Postgres SQLSTATE): the message can quote values.
 */
export async function markFailed(sql: Sql, id: bigint, error: unknown): Promise<void> {
  await sql`update platform.outbox
    set last_error = ${errorLabel(error)},
        next_attempt_at = now() + make_interval(secs => least(power(2, attempts), 300))
    where id = ${id.toString()}`;
}
