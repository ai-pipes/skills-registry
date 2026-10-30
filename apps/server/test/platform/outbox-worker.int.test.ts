import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { type CatalogDeps, createPgCatalog, createSkill } from '../../src/modules/catalog/index.ts';
import {
  createCatalogSkillReader,
  createPgSearch,
  indexMissingEmbeddings,
  searchEventHandlers,
  type SearchDeps,
} from '../../src/modules/search/index.ts';
import { PgAuditLog } from '../../src/platform/audit.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { appendOutbox, MAX_ATTEMPTS } from '../../src/platform/outbox.ts';
import { type OutboxWorkerDeps, startOutboxWorker } from '../../src/platform/outbox-worker.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { FixedClock } from '../fakes/fixed-clock.ts';
import { shaHasher } from '../fakes/sha-hasher.ts';
import { startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let catalog: CatalogDeps;
let embedder: FakeEmbedder;
let search: SearchDeps;
let worker: { stop(): Promise<void> } | null = null;

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  catalog = {
    ...createPgCatalog(pg.sql),
    hasher: shaHasher,
    ids: { uuid: () => randomUUID() },
    clock: new FixedClock(),
    audit: new PgAuditLog(pg.sql),
  };
  embedder = new FakeEmbedder();
  search = {
    ...createPgSearch(pg.sql),
    embedder,
    skills: createCatalogSkillReader(catalog),
    minSimilarity: 0.3,
  };
});
afterEach(async () => {
  await worker?.stop();
  worker = null;
});

const logger = createLogger('silent');
const enc = (s: string) => new TextEncoder().encode(s);

function start(
  handlers = searchEventHandlers(search),
  extra: Partial<Pick<OutboxWorkerDeps, 'sweep' | 'logger'>> = {},
) {
  worker = startOutboxWorker({ sql: pg.sql, handlers, intervalMs: 20, logger, ...extra });
  return worker;
}

/** A logger that keeps every line as parsed JSON. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger('info', {
    write: (line: string) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) lines.push({ ...parsed });
    },
  });
  return { lines, log };
}

async function until(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  if (await check()) return;
  if (timeoutMs <= 0) throw new Error('condition not met in time');
  await new Promise((r) => setTimeout(r, 10));
  await until(check, timeoutMs - 10);
}

type OutboxState = { attempts: number; processed: boolean; last_error: string | null };
const outbox = () =>
  pg.sql<OutboxState[]>`
    select attempts, processed_at is not null as processed, last_error
    from platform.outbox order by id`;
const document = async () =>
  (
    await pg.sql<{ has_embedding: boolean }[]>`
      select embedding is not null as has_embedding from search.documents where slug = 'pdf'`
  )[0];

async function createPdfSkill() {
  const res = await createSkill(catalog, {
    slug: 'pdf',
    folder: 'general',
    files: [
      {
        path: 'SKILL.md',
        bytes: enc('---\nname: pdf\ndescription: Extract text from PDF files\n---\nUse it.\n'),
      },
    ],
    actorId: randomUUID(),
    message: null,
    source: null,
    sourceCommit: null,
  });
  if (!res.ok) throw res.error;
}

describe('outbox worker', () => {
  it('indexes a created skill after one tick', async () => {
    await createPdfSkill();
    start();
    await until(async () => (await outbox())[0]?.processed === true);
    expect(await outbox()).toEqual([{ attempts: 1, processed: true, last_error: null }]);
    expect(await document()).toEqual({ has_embedding: true });
  });

  it('keeps the event for retry while the embedder fails, without blocking publication', async () => {
    embedder.failing = true;
    await createPdfSkill();
    expect(await pg.sql`select 1 from catalog.skills where slug = 'pdf'`).toHaveLength(1);

    const w = start();
    await until(async () => (await outbox())[0]?.last_error != null);
    await w.stop();
    expect(await outbox()).toEqual([{ attempts: 1, processed: false, last_error: 'Error' }]);
    // FTS row is written right away, the embedding is filled in by the retry.
    expect(await document()).toEqual({ has_embedding: false });

    embedder.failing = false;
    await pg.sql`update platform.outbox set next_attempt_at = now() - interval '1 second'`;
    start();
    await until(async () => (await outbox())[0]?.processed === true);
    expect(await outbox()).toEqual([{ attempts: 2, processed: true, last_error: null }]);
    expect(await document()).toEqual({ has_embedding: true });
  });

  it('marks events without a handler as processed', async () => {
    await pg.sql.begin((tx) =>
      appendOutbox(tx, [{ type: 'unknown.event', occurredAt: new Date(), payload: {} }]),
    );
    start({});
    await until(async () => (await outbox())[0]?.processed === true);
    expect(await outbox()).toEqual([{ attempts: 1, processed: true, last_error: null }]);
  });

  it('stop() waits for the running tick and ends the loop', async () => {
    let calls = 0;
    const w = start({
      'test.slow': async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 100));
      },
    });
    await pg.sql.begin((tx) =>
      appendOutbox(tx, [{ type: 'test.slow', occurredAt: new Date(), payload: {} }]),
    );
    await until(async () => calls === 1);
    await w.stop();
    expect(await outbox()).toEqual([{ attempts: 1, processed: true, last_error: null }]);
    await pg.sql.begin((tx) =>
      appendOutbox(tx, [{ type: 'test.slow', occurredAt: new Date(), payload: {} }]),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
  });

  it('gives up after the last attempt with an error log; the sweep fills the embedding later', async () => {
    embedder.failing = true;
    await createPdfSkill();
    // Skip the backoff: the next claim is the last allowed attempt.
    await pg.sql`update platform.outbox set attempts = ${MAX_ATTEMPTS - 1}`;
    const { lines, log } = captureLogger();
    start(searchEventHandlers(search), {
      logger: log,
      sweep: {
        everyMs: 50,
        run: async () => void (await indexMissingEmbeddings(search, { limit: 20 })),
      },
    });

    await until(async () => lines.some((l) => l['msg'] === 'outbox: handler failed, giving up'));
    // The log line can precede the row update; wait for the stored error.
    await until(async () => (await outbox())[0]?.last_error != null);
    const [row] = await outbox();
    expect(row).toEqual({
      attempts: MAX_ATTEMPTS,
      processed: false,
      last_error: 'Error',
    });
    const final = lines.find((l) => l['msg'] === 'outbox: handler failed, giving up');
    expect(final).toMatchObject({
      level: 50,
      type: 'catalog.skill_version_created',
      attempts: MAX_ATTEMPTS,
    });
    expect(typeof final?.['outboxId']).toBe('string');
    expect(JSON.stringify(final)).not.toContain('payload');
    // neither the stored last_error nor the log carries the message
    expect(final?.['err']).toMatchObject({ name: 'Error' });
    expect(lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain('embedder unavailable');
    expect(lines.some((l) => l['msg'] === 'outbox: handler failed, will retry')).toBe(false);
    expect(await document()).toEqual({ has_embedding: false });

    // The event is exhausted; once the embedder recovers, the sweep fills the embedding in.
    embedder.failing = false;
    await until(async () => (await document())?.has_embedding === true);
    expect((await outbox())[0]?.processed).toBe(false);
  });

  it('stores only the error name and a short code in last_error, never the message', async () => {
    const pgError = Object.assign(
      new Error('invalid input syntax for type uuid: "secret-value-xyz"'),
      { code: '22P02' },
    );
    await pg.sql.begin((tx) =>
      appendOutbox(tx, [{ type: 'test.broken', occurredAt: new Date(), payload: {} }]),
    );
    start({
      'test.broken': async () => {
        throw pgError;
      },
    });
    await until(async () => (await outbox())[0]?.last_error != null);
    expect(await outbox()).toEqual([{ attempts: 1, processed: false, last_error: 'Error: 22P02' }]);
  });

  it('runs the sweep at most once per everyMs, and a failing sweep does not stop the worker', async () => {
    let runs = 0;
    const { lines, log } = captureLogger();
    start(
      {},
      {
        logger: log,
        sweep: {
          everyMs: 60_000,
          run: async () => {
            runs += 1;
            throw new Error('sweep broke: secret-value-xyz');
          },
        },
      },
    );
    await until(async () => runs === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(runs).toBe(1);
    expect(lines.find((l) => l['msg'] === 'outbox: sweep failed')).toMatchObject({
      level: 40,
      err: { name: 'Error' },
    });
    expect(lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain('secret-value-xyz');
    await pg.sql.begin((tx) =>
      appendOutbox(tx, [{ type: 'unknown.event', occurredAt: new Date(), payload: {} }]),
    );
    await until(async () => (await outbox())[0]?.processed === true);
  });
});
