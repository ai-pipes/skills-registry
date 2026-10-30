import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { ConfigError, loadConfig } from '../../src/platform/config.ts';

const base = {
  DATABASE_URL: 'postgres://u:p@h/db',
  PUBLIC_URL: 'http://localhost:3000',
};

/** Parses a dotenv-like file: KEY=value lines, `#` comments and blank lines ignored. */
function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`not a KEY=value line: ${line}`);
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      port: 3000,
      trustProxy: false,
      trustProxyHops: 1,
      cookieSecure: true,
      embedder: 'local',
      modelDir: '/app/models',
      logLevel: 'info',
      allowedHosts: [],
      searchMinSimilarity: 0.8,
    });
  });

  it('parses overrides', () => {
    const c = loadConfig({
      ...base,
      PORT: '8080',
      ALLOWED_HOSTS: 'a.com, b.com',
      TRUST_PROXY: 'true',
      TRUST_PROXY_HOPS: '2',
      SEARCH_MIN_SIMILARITY: '0.5',
    });
    expect(c.port).toBe(8080);
    expect(c.allowedHosts).toEqual(['a.com', 'b.com']);
    expect(c.trustProxy).toBe(true);
    expect(c.trustProxyHops).toBe(2);
    expect(c.searchMinSimilarity).toBe(0.5);
  });

  it('bounds TRUST_PROXY_HOPS to 1..5', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: '6' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: '1.5' })).toThrow(ConfigError);
  });

  it('bounds SEARCH_MIN_SIMILARITY to 0..1', () => {
    expect(() => loadConfig({ ...base, SEARCH_MIN_SIMILARITY: '1.5' })).toThrow(/SEARCH_MIN/);
    expect(() => loadConfig({ ...base, SEARCH_MIN_SIMILARITY: '-0.1' })).toThrow(/SEARCH_MIN/);
  });

  it('rejects a missing database url', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('treats empty optional values as unset', () => {
    const c = loadConfig({
      ...base,
      ADMIN_LOGIN: '',
      ADMIN_PASSWORD: '',
      SESSION_SECRET: '',
      EMBEDDER_URL: '',
      EMBEDDER_MODEL: '',
      ALLOWED_HOSTS: '',
      TRUST_PROXY: '',
      PORT: '',
    });
    expect(c.adminLogin).toBeUndefined();
    expect(c.adminPassword).toBeUndefined();
    expect(c.sessionSecret).toBeUndefined();
    expect(c.embedderUrl).toBeUndefined();
    expect(c.embedderModel).toBeUndefined();
    expect(c.trustProxy).toBe(false);
    expect(c.port).toBe(3000);
  });

  it('keeps SESSION_SECRET optional but rejects a short one', () => {
    expect(loadConfig(base).sessionSecret).toBeUndefined();
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('reports every bad variable by name, one per line', () => {
    let message = '';
    try {
      loadConfig({ ...base, PORT: 'abc', PUBLIC_URL: 'not a url' });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof Error) message = e.message;
    }
    expect(message).toContain('PORT');
    const lines = message.split('\n');
    expect(lines.some((l) => l.includes('PORT') && !l.includes('PUBLIC_URL'))).toBe(true);
    expect(lines.some((l) => l.includes('PUBLIC_URL') && !l.includes('PORT:'))).toBe(true);
  });

  it('accepts the shipped .env.example once the required values are filled in', () => {
    const file = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
    const env = parseEnvFile(file);
    const c = loadConfig({ ...env, DATABASE_URL: 'postgres://skills@db:5432/skills' });
    expect(c.port).toBe(3000);
    expect(c.adminLogin).toBe('admin');
    expect(c.adminPassword).toBeUndefined();
  });
});

describe('single sign-on settings', () => {
  const oidc = {
    OIDC_ISSUER: 'https://id.example.com/realms/main',
    OIDC_CLIENT_ID: 'skills',
    OIDC_CLIENT_SECRET: 'secret',
  };

  it('is off without OIDC settings (password sign-in)', () => {
    expect(loadConfig(base).oidc).toBeUndefined();
    expect(
      loadConfig({ ...base, OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' }).oidc,
    ).toBeUndefined();
  });

  it('is on with all three, with default groups, scopes and claim', () => {
    expect(loadConfig({ ...base, ...oidc }).oidc).toEqual({
      issuer: oidc.OIDC_ISSUER,
      clientId: 'skills',
      clientSecret: 'secret',
      loginGroup: 'skills-users',
      adminGroup: 'skills-admins',
      scopes: 'openid profile email groups',
      groupsClaim: 'groups',
    });
  });

  it('parses overrides; scopes may be comma or space separated, deduplicated', () => {
    const c = loadConfig({
      ...base,
      ...oidc,
      OIDC_LOGIN_GROUP: 'staff',
      OIDC_ADMIN_GROUP: 'ops',
      OIDC_SCOPES: 'openid, profile  roles,openid',
      OIDC_GROUPS_CLAIM: 'urn:zitadel:iam:org:project:roles',
    });
    expect(c.oidc).toMatchObject({
      loginGroup: 'staff',
      adminGroup: 'ops',
      scopes: 'openid profile roles',
      groupsClaim: 'urn:zitadel:iam:org:project:roles',
    });
  });

  it('requires openid in the scopes', () => {
    expect(() => loadConfig({ ...base, ...oidc, OIDC_SCOPES: 'profile email' })).toThrow(
      /OIDC_SCOPES: must include openid/,
    );
  });

  it('rejects partial settings, naming each missing variable', () => {
    let message = '';
    try {
      loadConfig({ ...base, OIDC_ISSUER: oidc.OIDC_ISSUER });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof Error) message = e.message;
    }
    expect(message).toMatch(/OIDC_CLIENT_ID: required/);
    expect(message).toMatch(/OIDC_CLIENT_SECRET: required/);
    expect(message).not.toMatch(/OIDC_ISSUER: /);
    expect(() => loadConfig({ ...base, OIDC_CLIENT_SECRET: 'x' })).toThrow(/OIDC_ISSUER: required/);
  });

  it('rejects an issuer that is not a URL', () => {
    expect(() => loadConfig({ ...base, ...oidc, OIDC_ISSUER: 'nope' })).toThrow(/OIDC_ISSUER/);
  });
});
