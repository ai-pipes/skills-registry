import { z } from 'zod';

export const CreateTokenRequest = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateTokenRequest = z.infer<typeof CreateTokenRequest>;

export const TokenSummary = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type TokenSummary = z.infer<typeof TokenSummary>;

/** The plaintext token is returned once, here, and never again. */
export const CreatedToken = z.object({
  id: z.string(),
  prefix: z.string(),
  token: z.string(),
  connectCommand: z.string(),
});
export type CreatedToken = z.infer<typeof CreatedToken>;
