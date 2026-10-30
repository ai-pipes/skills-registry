// Server entry point (`node dist/main.js`): migrate, bootstrap the first admin, start the
// outbox worker, warm the embedder in the background and serve HTTP on 0.0.0.0:$PORT.
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { bootstrapAdmin } from '../modules/identity/index.ts';
import { indexMissingEmbeddings, searchEventHandlers } from '../modules/search/index.ts';
import { errorFields } from '../shared-kernel/index.ts';
import { loadConfigOrExit } from './config.ts';
import { buildContainer } from './container.ts';
import { createDb } from './db.ts';
import { createHttpApp } from './http/app.ts';
import { findMigrationsDir, migrate } from './migrate.ts';
import { startOutboxWorker } from './outbox-worker.ts';

const OUTBOX_INTERVAL_MS = 1000;
// Recovery sweep for documents left without an embedding (outbox gave up during an embedder
// outage): once a minute, 20 sequential embeddings, a few seconds on CPU, well within the lease.
const SWEEP_EVERY_MS = 60_000;
const SWEEP_BATCH = 20;
const SHUTDOWN_TIMEOUT_MS = 10_000;
// This file only runs bundled, as apps/server/dist/main.js; the built UI is apps/web/dist.
const WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

const config = loadConfigOrExit(process.env);
const sql = createDb(config.databaseUrl);
const container = buildContainer(config, sql);
const { logger } = container;

const applied = await migrate(sql, findMigrationsDir(import.meta.url));
logger.info({ applied }, 'migrations applied');

if (config.oidc !== undefined) {
  // Admins come from the provider's admin group; a password admin could not sign in anyway.
  if (config.adminLogin !== undefined || config.adminPassword !== undefined) {
    logger.warn('single sign-on is configured: ADMIN_LOGIN/ADMIN_PASSWORD are ignored');
  }
  logger.info({ issuer: config.oidc.issuer }, 'web sign-in: single sign-on');
} else if (config.adminLogin !== undefined && config.adminPassword !== undefined) {
  const boot = await bootstrapAdmin(container.identity, {
    login: config.adminLogin,
    password: config.adminPassword,
  });
  if (!boot.ok) throw new Error(`ADMIN_LOGIN/ADMIN_PASSWORD rejected: ${boot.error.message}`);
  if (boot.value) logger.info({ login: config.adminLogin }, 'first admin created');
} else if (config.adminLogin !== undefined || config.adminPassword !== undefined) {
  logger.warn('set both ADMIN_LOGIN and ADMIN_PASSWORD to create the first admin');
}

const worker = startOutboxWorker({
  sql,
  handlers: searchEventHandlers(container.search),
  intervalMs: OUTBOX_INTERVAL_MS,
  logger,
  sweep: {
    everyMs: SWEEP_EVERY_MS,
    run: async () => {
      // Bounded: stops after 3 consecutive failures (outage) or 30 s, so it never holds the
      // outbox worker loop for long. Failed slugs are logged, never content.
      const r = await indexMissingEmbeddings(container.search, { limit: SWEEP_BATCH });
      if (r.indexed.length > 0)
        logger.info({ documents: r.indexed.length }, 'search: filled in missing embeddings');
      if (r.failed.length > 0 || r.stoppedEarly !== null)
        logger.warn(
          { failed: r.failed, stoppedEarly: r.stoppedEarly },
          'search: embedding sweep had failures',
        );
    },
  },
});

// Loads the model so the first search does not wait for it; failures only get logged.
container.search.embedder.embedQuery('warm-up').then(
  () => logger.info('embedder ready'),
  (error: unknown) => logger.warn({ err: errorFields(error) }, 'embedder warm-up failed'),
);

const http = createHttpApp(container, { webRoot: WEB_ROOT });
const server = serve({ fetch: http.app.fetch, hostname: '0.0.0.0', port: config.port }, (info) =>
  logger.info({ port: info.port }, 'listening'),
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Stop accepting first; in-flight requests drain while the rest shuts down.
  const drained = new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await http.close();
  await drained;
  await sql.end({ timeout: 5 });
  logger.info('stopped');
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error({ err: errorFields(error) }, 'shutdown failed');
      process.exit(1);
    });
  });
}
