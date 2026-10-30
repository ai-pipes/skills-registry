import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface FakeClaims {
  sub: string;
  preferred_username?: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
}

interface Grant {
  claims: FakeClaims;
  nonce: string;
  challenge: string;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/**
 * A minimal OIDC provider on a local port: discovery, JWKS and the token endpoint, with real
 * ES256-signed ID tokens and PKCE verification. The "browser" step (`authorize`) is the test.
 */
export class FakeIdp {
  readonly clientId = 'skills-registry';
  readonly clientSecret = 'client-secret';
  issuer = '';
  /** The scope the authorization request must carry. */
  expectedScope = 'openid profile email groups';
  /** The claim the groups are emitted under (in the ID token and UserInfo). */
  groupsClaim = 'groups';
  /** Leaves `groups` out of the ID token; UserInfo still has them. */
  groupsOnlyInUserInfo = false;
  /** Makes UserInfo answer 500, as in a provider outage. */
  userinfoFails = false;
  /** Makes discovery answer 503: the provider is down. */
  discoveryDown = false;
  /** When set, the token endpoint answers this status with a plain-text body (an outage). */
  tokenStatus: number | null = null;
  private server: Server | undefined;
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, FakeClaims>();
  private readonly privateKey;
  private readonly jwk;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        if (this.discoveryDown) return void res.writeHead(503).end();
        return json(res, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['ES256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          code_challenge_methods_supported: ['S256'],
          userinfo_endpoint: `${this.issuer}/userinfo`,
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === '/jwks') return json(res, { keys: [this.jwk] });
      if (url.pathname === '/userinfo') {
        if (this.userinfoFails) return void res.writeHead(500).end();
        const claims = this.accessTokens.get((req.headers.authorization ?? '').slice(7));
        if (!claims) return void res.writeHead(401).end();
        return json(res, this.emitted(claims));
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => this.token(new URLSearchParams(Buffer.concat(chunks).toString()), res));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('fake provider did not bind a port');
    }
    this.issuer = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections();
    });
  }

  /** What the user's browser does at the provider: log in, get a code for the given attempt. */
  authorize(authorizationUrl: URL, claims: FakeClaims): string {
    const p = authorizationUrl.searchParams;
    if (p.get('client_id') !== this.clientId || p.get('code_challenge_method') !== 'S256') {
      throw new Error('bad authorization request');
    }
    if (p.get('scope') !== this.expectedScope) throw new Error('bad scope');
    const code = randomUUID();
    this.grants.set(code, {
      claims,
      nonce: p.get('nonce') ?? '',
      challenge: p.get('code_challenge') ?? '',
    });
    return code;
  }

  private token(form: URLSearchParams, res: import('node:http').ServerResponse): void {
    if (this.tokenStatus !== null) {
      res.writeHead(this.tokenStatus, { 'content-type': 'text/plain' });
      res.end('unavailable');
      return;
    }
    const grant = this.grants.get(form.get('code') ?? '');
    this.grants.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (
      !grant ||
      form.get('client_secret') !== this.clientSecret ||
      form.get('client_id') !== this.clientId ||
      challenge !== grant.challenge
    ) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const accessToken = `access-${randomUUID()}`;
    this.accessTokens.set(accessToken, grant.claims);
    json(res, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: this.idToken({
        iss: this.issuer,
        aud: this.clientId,
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        ...(this.groupsOnlyInUserInfo
          ? { ...grant.claims, groups: undefined }
          : this.emitted(grant.claims)),
      }),
    });
  }

  /** The claims as this provider emits them: groups under `groupsClaim`. */
  private emitted(claims: FakeClaims): Record<string, unknown> {
    const { groups, ...rest } = claims;
    return groups === undefined ? rest : { ...rest, [this.groupsClaim]: groups };
  }

  private idToken(payload: Record<string, unknown>): string {
    const head = b64url(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${head}.${body}.${b64url(sig)}`;
  }
}

function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
