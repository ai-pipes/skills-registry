import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { PgAuditLog } from '../../src/platform/audit.ts';
import { appendOutbox, claimOutbox, markFailed, markProcessed } from '../../src/platform/outbox.ts';
import { startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
});

const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    type: 'test.happened',
    occurredAt: new Date(),
    payload: { i },
  }));

describe('outbox', () => {
  it('claims each row once under concurrency', async () => {
    await pg.sql.begin((tx) => appendOutbox(tx, events(20)));
    const [a, b] = await Promise.all([claimOutbox(pg.sql, 20), claimOutbox(pg.sql, 20)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect([...a, ...b].every((r) => r.attempts === 1)).toBe(true);
  });

  it('round-trips payload and marks processed', async () => {
    await pg.sql.begin((tx) => appendOutbox(tx, events(1)));
    const [row] = await claimOutbox(pg.sql, 5);
    expect(row?.payload).toEqual({ i: 0 });
    expect(row?.type).toBe('test.happened');
    await markProcessed(pg.sql, row!.id);
    expect(await claimOutbox(pg.sql, 5)).toEqual([]);
  });

  it('backs off failed rows', async () => {
    await pg.sql.begin((tx) => appendOutbox(tx, events(1)));
    const [row] = await claimOutbox(pg.sql, 5);
    await markFailed(pg.sql, row!.id, new RangeError('boom: secret-value-xyz'));
    expect(await pg.sql`select last_error from platform.outbox`).toEqual([
      { last_error: 'RangeError' },
    ]);
    expect(await claimOutbox(pg.sql, 5)).toEqual([]);
    await pg.sql`update platform.outbox set next_attempt_at = now() - interval '1 second'`;
    const again = await claimOutbox(pg.sql, 5);
    expect(again).toHaveLength(1);
    expect(again[0]?.attempts).toBe(2);
  });

  it('stops after 10 attempts', async () => {
    await pg.sql.begin((tx) => appendOutbox(tx, events(1)));
    await Array.from({ length: 10 }).reduce<Promise<void>>(async (prev) => {
      await prev;
      const rows = await claimOutbox(pg.sql, 5);
      expect(rows).toHaveLength(1);
      await markFailed(pg.sql, rows[0]!.id, new Error('boom'));
      await pg.sql`update platform.outbox set next_attempt_at = now() - interval '1 second'`;
    }, Promise.resolve());
    expect(await claimOutbox(pg.sql, 5)).toEqual([]);
  });
});

describe('PgAuditLog', () => {
  it('records an entry', async () => {
    await new PgAuditLog(pg.sql).record({
      actorId: null,
      action: 'x.y',
      target: 't',
      meta: { a: 1 },
    });
    const [row] = await pg.sql`select action, target, meta, actor_id from platform.audit_log`;
    expect(row).toMatchObject({ action: 'x.y', target: 't', meta: { a: 1 }, actor_id: null });
  });
});
