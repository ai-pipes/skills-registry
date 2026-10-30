import { z } from 'zod';
import { DEFAULT_GROUPS_CLAIM, DEFAULT_OIDC_SCOPES } from '../modules/identity/index.ts';
import { DEFAULT_MIN_SIMILARITY } from '../modules/search/index.ts';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true'));

/** Space- or comma-separated scopes, normalised to one space; `openid` is required. */
const oidcScopes = z
  .string()
  .default(DEFAULT_OIDC_SCOPES)
  .transform((v) => v.split(/[\s,]+/).filter((s) => s !== ''))
  .refine((list) => list.includes('openid'), { message: 'must include openid' })
  .transform((list) => [...new Set(list)].join(' '));

const OIDC_REQUIRED = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;

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
  // Single sign-on: all of ISSUER, CLIENT_ID and CLIENT_SECRET, or none of them.
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_LOGIN_GROUP: z.string().min(1).default('skills-users'),
  OIDC_ADMIN_GROUP: z.string().min(1).default('skills-admins'),
  OIDC_SCOPES: oidcScopes,
  OIDC_GROUPS_CLAIM: z.string().min(1).default(DEFAULT_GROUPS_CLAIM),
  // Plain-http issuer (private network, tests): tokens and the client secret travel unencrypted.
  OIDC_ALLOW_INSECURE: bool(false),
});

/** Partial OIDC settings are a mistake, not "SSO off": name each missing variable. */
const checkedSchema = schema.superRefine((e, ctx) => {
  if (
    e.OIDC_ISSUER !== undefined &&
    URL.canParse(e.OIDC_ISSUER) &&
    new URL(e.OIDC_ISSUER).protocol !== 'https:' &&
    !e.OIDC_ALLOW_INSECURE
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['OIDC_ISSUER'],
      message: 'must be an https: URL (set OIDC_ALLOW_INSECURE=true to allow http:)',
    });
  }
  const missing = OIDC_REQUIRED.filter((k) => e[k] === undefined);
  if (missing.length === 0 || missing.length === OIDC_REQUIRED.length) return;
  for (const key of missing) {
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `required when any of ${OIDC_REQUIRED.join(', ')} is set`,
    });
  }
});

/** Invalid environment: the message names each bad variable, one per line. */
export class ConfigError extends Error {
  constructor(issues: readonly z.core.$ZodIssue[]) {
    const lines = issues.map((i) => `  ${i.path.map(String).join('.') || '(env)'}: ${i.message}`);
    super(`Invalid configuration:\n${lines.join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Single sign-on through an OIDC provider; when present the web UI signs in with SSO only. */
interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Provider group whose members may sign in (as `member`). */
  loginGroup: string;
  /** Provider group whose members are admins. */
  adminGroup: string;
  /** Scopes of the authorization request, space-separated, always with `openid`. */
  scopes: string;
  /** ID token / UserInfo claim holding the person's groups. */
  groupsClaim: string;
  /** A plain `http:` issuer is allowed (OIDC_ALLOW_INSECURE). */
  allowInsecure: boolean;
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
  /** Set when OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are all set. */
  oidc?: OidcConfig;
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
  const parsed = checkedSchema.safeParse(set);
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
  if (
    e.OIDC_ISSUER !== undefined &&
    e.OIDC_CLIENT_ID !== undefined &&
    e.OIDC_CLIENT_SECRET !== undefined
  ) {
    config.oidc = {
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      loginGroup: e.OIDC_LOGIN_GROUP,
      adminGroup: e.OIDC_ADMIN_GROUP,
      scopes: e.OIDC_SCOPES,
      groupsClaim: e.OIDC_GROUPS_CLAIM,
      allowInsecure: e.OIDC_ALLOW_INSECURE,
    };
  }
  return config;
}
