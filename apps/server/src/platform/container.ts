import { randomUUID } from 'node:crypto';
import { type CatalogDeps, createPgCatalog, nodeHasher } from '../modules/catalog/index.ts';
import {
  createPgIdentity,
  type IdentityDeps,
  type OidcProvider,
  OpenidProvider,
} from '../modules/identity/index.ts';
import {
  createCatalogSkillReader,
  createPgSearch,
  type Embedder,
  OpenAiCompatibleEmbedder,
  type SearchDeps,
  TransformersEmbedder,
} from '../modules/search/index.ts';
import { type AuditLog, type Clock, systemClock } from '../shared-kernel/index.ts';
import { PgAuditLog } from './audit.ts';
import type { Config } from './config.ts';
import type { Sql } from './db.ts';
import { createLogger, type Logger } from './logger.ts';

export type Container = {
  catalog: CatalogDeps;
  identity: IdentityDeps;
  search: SearchDeps;
  audit: AuditLog;
  logger: Logger;
  config: Config;
  sql: Sql;
};

export type ContainerOptions = {
  embedder?: Embedder;
  logger?: Logger;
  clock?: Clock;
  /** Replaces the OIDC provider built from `config.oidc` (tests); ignored without `config.oidc`. */
  oidc?: OidcProvider;
};

/** The provider sends the browser back here after single sign-on. */
export function ssoRedirectUri(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/auth/sso/callback`;
}

function ssoDeps(config: Config, logger: Logger, override?: OidcProvider): IdentityDeps['sso'] {
  const oidc = config.oidc;
  if (!oidc) return null;
  const provider =
    override ??
    new OpenidProvider({
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      redirectUri: ssoRedirectUri(config.publicUrl),
      scopes: oidc.scopes,
      groupsClaim: oidc.groupsClaim,
      allowInsecure: oidc.allowInsecure,
      logger,
    });
  return {
    issuer: oidc.issuer,
    provider,
    policy: { loginGroup: oidc.loginGroup, adminGroup: oidc.adminGroup },
  };
}

function createEmbedder(config: Config): Embedder {
  if (config.embedder === 'openai-compatible') {
    if (!config.embedderUrl || !config.embedderModel) {
      throw new Error(
        'EMBEDDER_URL and EMBEDDER_MODEL are required for EMBEDDER=openai-compatible',
      );
    }
    return new OpenAiCompatibleEmbedder({ url: config.embedderUrl, model: config.embedderModel });
  }
  return new TransformersEmbedder({ modelDir: config.modelDir, allowRemote: false });
}

/** Composition root: wires every module's ports by hand. Does not start the outbox worker. */
export function buildContainer(config: Config, sql: Sql, opts: ContainerOptions = {}): Container {
  const audit = new PgAuditLog(sql);
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createLogger(config.logLevel);
  const catalog: CatalogDeps = {
    ...createPgCatalog(sql),
    hasher: nodeHasher,
    ids: { uuid: () => randomUUID() },
    clock,
    audit,
  };
  const identity: IdentityDeps = {
    ...createPgIdentity(sql),
    sso: ssoDeps(config, logger, opts.oidc),
    audit,
    clock,
  };
  const search: SearchDeps = {
    ...createPgSearch(sql),
    embedder: opts.embedder ?? createEmbedder(config),
    skills: createCatalogSkillReader(catalog),
    minSimilarity: config.searchMinSimilarity,
  };
  return { catalog, identity, search, audit, logger, config, sql };
}
