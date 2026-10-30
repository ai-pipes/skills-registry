import { z } from 'zod';

/**
 * Deliberately loose: over-long values are rejected by Identity with the same response as a
 * wrong password, so the schema only bounds the work done on the request.
 */
export const LoginRequest = z.object({
  login: z.string().max(1024),
  password: z.string().max(4096),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Role = z.enum(['admin', 'member']);
export type Role = z.infer<typeof Role>;

export const MeResponse = z.object({ login: z.string(), role: Role });
export type MeResponse = z.infer<typeof MeResponse>;

/** How people sign in to the web UI: a password form, or single sign-on through an OIDC provider. */
export const AuthMethod = z.enum(['password', 'sso']);
export type AuthMethod = z.infer<typeof AuthMethod>;

/** `GET /api/auth/config` (no session needed): what the login page should offer. */
export const AuthConfigResponse = z.object({ method: AuthMethod });
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

/** `GET /api/auth/sso/login?returnTo=…`: starts single sign-on, comes back to `returnTo`. */
export const SsoLoginQuery = z.object({ returnTo: z.string().max(2048).default('/') });
export type SsoLoginQuery = z.infer<typeof SsoLoginQuery>;

/** `GET /api/auth/sso/callback`: the provider's answer (RFC 6749 §4.1.2, `iss` per RFC 9207). */
export const SsoCallbackQuery = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256),
  iss: z.string().max(2048).optional(),
});
export type SsoCallbackQuery = z.infer<typeof SsoCallbackQuery>;

/**
 * Why single sign-on failed; the callback redirects to `/login?loginError=<code>`.
 * Any other value is shown as a generic error.
 */
export const SsoLoginError = z.enum([
  'invalid_state',
  'not_allowed',
  'disabled',
  'idp_unavailable',
  'internal',
]);
export type SsoLoginError = z.infer<typeof SsoLoginError>;
