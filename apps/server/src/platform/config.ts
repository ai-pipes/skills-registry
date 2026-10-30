import { z } from 'zod';
import { DEFAULT_MIN_SIMILARITY } from '../modules/search/index.ts';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true'));

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.url(),
  ALLOWED_HOSTS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    ),
  TRUST_PROXY: bool(false),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
  COOKIE_SECURE: bool(true),
  // Reserved: sessions are random ids hashed in the DB, nothing is signed with it yet.
  SESSION_SECRET: z.string().min(32).optional(),
  ADMIN_LOGIN: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  EMBEDDER: z.enum(['local', 'openai-compatible']).default('local'),
  EMBEDDER_URL: z.url().optional(),
  EMBEDDER_MODEL: z.string().min(1).optional(),
  MODEL_DIR: z.string().default('/app/models'),
  SEARCH_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(DEFAULT_MIN_SIMILARITY),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Invalid environment: the message names each bad variable, one per line. */
export class ConfigError extends Error {
  constructor(issues: readonly z.core.$ZodIssue[]) {
    const lines = issues.map((i) => `  ${i.path.map(String).join('.') || '(env)'}: ${i.message}`);
    super(`Invalid configuration:\n${lines.join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface Config {
  port: number;
  databaseUrl: string;
  publicUrl: string;
  allowedHosts: string[];
  trustProxy: boolean;
  /** With trustProxy: the client is the hop this many entries from the right of X-Forwarded-For. */
  trustProxyHops: number;
  cookieSecure: boolean;
  /** Reserved, currently unused. */
  sessionSecret?: string;
  adminLogin?: string;
  adminPassword?: string;
  embedder: 'local' | 'openai-compatible';
  embedderUrl?: string;
  embedderModel?: string;
  modelDir: string;
  /** Cosine-similarity floor for vector search candidates (ADR 0005). */
  searchMinSimilarity: number;
  logLevel: string;
}

/** loadConfig for entry points: on bad env print the ConfigError message (no stack) and exit 1. */
export function loadConfigOrExit(env: NodeJS.ProcessEnv): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return process.exit(1);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // An empty value (`KEY=` in .env) means "unset", so defaults and optionality apply to it.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(set);
  if (!parsed.success) throw new ConfigError(parsed.error.issues);
  const e = parsed.data;
  const config: Config = {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.PUBLIC_URL,
    allowedHosts: e.ALLOWED_HOSTS,
    trustProxy: e.TRUST_PROXY,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    cookieSecure: e.COOKIE_SECURE,
    embedder: e.EMBEDDER,
    modelDir: e.MODEL_DIR,
    searchMinSimilarity: e.SEARCH_MIN_SIMILARITY,
    logLevel: e.LOG_LEVEL,
  };
  if (e.SESSION_SECRET !== undefined) config.sessionSecret = e.SESSION_SECRET;
  if (e.ADMIN_LOGIN !== undefined) config.adminLogin = e.ADMIN_LOGIN;
  if (e.ADMIN_PASSWORD !== undefined) config.adminPassword = e.ADMIN_PASSWORD;
  if (e.EMBEDDER_URL !== undefined) config.embedderUrl = e.EMBEDDER_URL;
  if (e.EMBEDDER_MODEL !== undefined) config.embedderModel = e.EMBEDDER_MODEL;
  return config;
}
