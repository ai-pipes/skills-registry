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
