import { DomainError } from '../../../shared-kernel/index.ts';

export type Role = 'admin' | 'member';

export interface Principal {
  userId: string;
  login: string;
  role: Role;
  /** `cli`: an operator acting as this user through the server CLI. */
  via: 'session' | 'token' | 'cli';
}

export interface User {
  id: string;
  login: string;
  passwordHash: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
}

export type IdentityErrorCode =
  | 'invalid_credentials'
  | 'locked'
  | 'disabled'
  | 'invalid_token'
  | 'rate_limited'
  | 'forbidden'
  | 'weak_password'
  | 'user_exists'
  | 'not_found';

export class IdentityError extends DomainError {
  constructor(
    override readonly code: IdentityErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(code, message);
    this.name = 'IdentityError';
  }
}

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024; // bounds argon2 work on hostile input

export function checkPassword(password: string): IdentityError | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return new IdentityError(
      'weak_password',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return new IdentityError('weak_password', 'password is too long');
  }
  return null;
}
