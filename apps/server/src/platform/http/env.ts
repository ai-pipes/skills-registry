import type { Principal } from '../../modules/identity/index.ts';

/** Per-request variables shared by the platform middleware and every module's routes. */
export type AppEnv = {
  Variables: {
    requestId: string;
    clientIp: string;
    /** Set by the session middleware on every /api route except login. */
    principal: Principal;
    /** How `principal` was authenticated: session cookie or Bearer token (ADR 0008). */
    authVia: 'session' | 'token';
  };
};
