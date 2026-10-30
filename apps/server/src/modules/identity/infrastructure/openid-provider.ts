import * as oidc from 'openid-client';
import type { OidcProvider } from '../application/ports.ts';
import { errorFields } from '../../../shared-kernel/index.ts';
import { IdentityError, type OidcClaims } from '../domain/user.ts';

export interface OpenidProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Absolute URL of `/api/auth/sso/callback` on this server. */
  redirectUri: string;
  /** Space-separated scopes of the authorization request; default `DEFAULT_OIDC_SCOPES`. */
  scopes?: string;
  /** Claim holding the person's groups; default `DEFAULT_GROUPS_CLAIM`. */
  groupsClaim?: string;
  /** Where degraded-provider warnings go; never receives tokens or claims. */
  logger?: { warn(fields: object, msg: string): void };
}

export const DEFAULT_OIDC_SCOPES = 'openid profile email groups';
export const DEFAULT_GROUPS_CLAIM = 'groups';

/**
 * Group names from a claim value: a list of strings (most providers), or an object whose keys
 * are the names (Zitadel's `urn:zitadel:iam:org:project:roles`). Anything else is `null`.
 */
export function groupsOf(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? value : null;
  if (value !== null && typeof value === 'object') return Object.keys(value);
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const statusOf = (value: unknown): number | null =>
  value !== null &&
  typeof value === 'object' &&
  'status' in value &&
  typeof value.status === 'number'
    ? value.status
    : null;

/**
 * Whether a failed request means the provider is down rather than that it refused: no answer
 * (fetch's network TypeError — openid-client's own argument errors carry a `code` — or a
 * timeout/abort) or a 5xx answer. OAuth error answers (`invalid_grant`, 4xx) are not outages.
 */
export function isProviderOutage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError && !('code' in error)) return true;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const status = statusOf(error) ?? statusOf(error.cause);
  return status !== null && status >= 500;
}

/** Discovery gives up after this long, so a login attempt never hangs on a dead provider. */
const DISCOVERY_TIMEOUT_SECONDS = 5;

/**
 * Any OIDC provider through `openid-client`: Authorization Code + PKCE. Discovery is
 * lazy: the server starts without the provider; the configuration is fetched on first use (with
 * a timeout), cached once it succeeded, and fetched again on the next use after a failure.
 * Meanwhile both methods throw `IdentityError('idp_unavailable')`.
 */
export class OpenidProvider implements OidcProvider {
  private config: Promise<oidc.Configuration> | null = null;

  constructor(private readonly cfg: OpenidProviderConfig) {}

  /** The provider configuration; concurrent callers share one discovery. */
  private configuration(): Promise<oidc.Configuration> {
    this.config ??= this.discover().catch((error: unknown) => {
      this.config = null;
      this.cfg.logger?.warn({ err: errorFields(error) }, 'oidc discovery failed');
      throw new IdentityError('idp_unavailable', 'the identity provider is unavailable');
    });
    return this.config;
  }

  private discover(): Promise<oidc.Configuration> {
    const issuer = new URL(this.cfg.issuer);
    // Plain http is for a provider on a private network or in tests; https issuers never reach it.
    const execute = issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [];
    return oidc.discovery(
      issuer,
      this.cfg.clientId,
      this.cfg.clientSecret,
      oidc.ClientSecretPost(this.cfg.clientSecret),
      { execute, timeout: DISCOVERY_TIMEOUT_SECONDS },
    );
  }

  async authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    nonce: string;
  }): Promise<URL> {
    return oidc.buildAuthorizationUrl(await this.configuration(), {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes ?? DEFAULT_OIDC_SCOPES,
      response_type: 'code',
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async exchange(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    iss?: string;
  }): Promise<OidcClaims> {
    // The state was already matched against our own store, so it is left out here; code and
    // iss are replayed as the provider sent them and openid-client validates `iss` (RFC 9207).
    const config = await this.configuration();
    const callback = new URL(this.cfg.redirectUri);
    callback.searchParams.set('code', input.code);
    if (input.iss !== undefined) callback.searchParams.set('iss', input.iss);
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: input.codeVerifier,
        expectedNonce: input.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      if (!isProviderOutage(error)) throw error;
      this.cfg.logger?.warn({ err: errorFields(error) }, 'oidc token endpoint unavailable');
      throw new IdentityError('idp_unavailable', 'the identity provider is unavailable');
    }
    const id = tokens.claims();
    if (!id) throw new Error('no ID token');
    const claim = this.cfg.groupsClaim ?? DEFAULT_GROUPS_CLAIM;
    let profile: Record<string, unknown> = { ...id };
    if (groupsOf(id[claim]) === null) {
      // Some providers keep groups out of the ID token; ask UserInfo as a fallback.
      try {
        profile = { ...(await oidc.fetchUserInfo(config, tokens.access_token, id.sub)) };
      } catch (error) {
        // No usable UserInfo: the person simply has no groups, so the policy refuses them.
        // Logged so that a provider outage is not mistaken for a missing group.
        this.cfg.logger?.warn(
          { sub: id.sub, err: errorFields(error) },
          'oidc userinfo failed; treating the person as having no groups',
        );
      }
    }
    return {
      sub: id.sub,
      preferredUsername: text(profile['preferred_username']) ?? text(id['preferred_username']),
      email: text(profile['email']) ?? text(id['email']),
      groups: groupsOf(profile[claim]) ?? [],
    };
  }
}
