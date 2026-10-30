import { errorFields } from '../shared-kernel/index.ts';
import type { Sql } from './db.ts';
import type { Logger } from './logger.ts';
import { claimOutbox, markFailed, MAX_ATTEMPTS, markProcessed, type OutboxRow } from './outbox.ts';

const BATCH_SIZE = 20;

type Handler = (payload: Record<string, unknown>) => Promise<void>;

export type OutboxWorkerDeps = {
  sql: Sql;
  handlers: Record<string, Handler>;
  intervalMs: number;
  logger: Logger;
  /**
   * Periodic job run from the worker loop at most once per `everyMs` (first on the first
   * tick), after the tick's deliveries. Used to repair what exhausted events left behind.
   */
  sweep?: { everyMs: number; run: () => Promise<void> };
};

async function deliver(deps: OutboxWorkerDeps, row: OutboxRow): Promise<void> {
  const handler = deps.handlers[row.type];
  if (!handler) {
    deps.logger.warn({ outboxId: String(row.id), type: row.type }, 'outbox: no handler, skipping');
    await markProcessed(deps.sql, row.id);
    return;
  }
  try {
    await handler(row.payload);
  } catch (error) {
    // Neither the log nor the row's last_error gets the message: it can quote values.
    const fields = {
      outboxId: String(row.id),
      type: row.type,
      attempts: row.attempts,
      err: errorFields(error),
    };
    if (row.attempts >= MAX_ATTEMPTS) {
      deps.logger.error(fields, 'outbox: handler failed, giving up');
    } else {
      deps.logger.warn(fields, 'outbox: handler failed, will retry');
    }
    await markFailed(deps.sql, row.id, error);
    return;
  }
  await markProcessed(deps.sql, row.id);
}

async function tick(deps: OutboxWorkerDeps): Promise<void> {
  const rows = await claimOutbox(deps.sql, BATCH_SIZE);
  // Sequential: events of one skill are applied in order, and each handler is short.
  await rows.reduce(async (prev, row) => {
    await prev;
    await deliver(deps, row);
  }, Promise.resolve());
}

async function sweep(deps: OutboxWorkerDeps, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    deps.logger.warn({ err: errorFields(error) }, 'outbox: sweep failed');
  }
}

/**
 * Polls the outbox every `intervalMs` (first tick immediately) and delivers events to handlers.
 * A failing handler leaves the row for retry with backoff (the last attempt logs an error);
 * an unknown type is marked processed. An optional `sweep` runs at most once per `everyMs`.
 * `stop()` cancels the next tick and waits for the running one.
 */
export function startOutboxWorker(deps: OutboxWorkerDeps): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let lastSweep = Number.NEGATIVE_INFINITY;

  const maybeSweep = async (): Promise<void> => {
    if (!deps.sweep || stopped || Date.now() - lastSweep < deps.sweep.everyMs) return;
    lastSweep = Date.now();
    await sweep(deps, deps.sweep.run);
  };

  const loop = (): void => {
    running = tick(deps)
      .catch((error: unknown) => {
        deps.logger.error({ err: errorFields(error) }, 'outbox: tick failed');
      })
      .then(maybeSweep)
      .then(() => {
        if (!stopped) timer = setTimeout(loop, deps.intervalMs);
      });
  };
  loop();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
