import { z } from 'zod';
import { Role } from './auth.ts';

export const CreateUserRequest = z.object({
  login: z.string().trim().min(1).max(128),
  password: z.string().max(1024),
  role: Role.default('member'),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const ResetPasswordRequest = z.object({ password: z.string().max(1024) });
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

export const SetDisabledRequest = z.object({ disabled: z.boolean().default(true) });
export type SetDisabledRequest = z.infer<typeof SetDisabledRequest>;

export const UserSummary = z.object({
  id: z.string(),
  login: z.string(),
  role: Role,
  disabled: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Linked to an identity provider account (signs in with SSO). */
  sso: z.boolean(),
  email: z.string().nullable(),
  /** Last successful web sign-in (password or SSO); null if never. */
  lastLoginAt: z.iso.datetime().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;
