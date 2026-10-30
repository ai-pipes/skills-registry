import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher, Sha256 } from '../application/ports.ts';

export const nodeSha256: Sha256 = {
  hex: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
  timingSafeEqual: (a, b) => {
    const x = createHash('sha256').update(a, 'utf8').digest();
    const y = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(x, y);
  },
};

export const cryptoRandom = {
  bytes: (n: number): Uint8Array => new Uint8Array(randomBytes(n)),
};

/** argon2id (the library default), OWASP minimum parameters. */
export class Argon2Hasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, { memoryCost: 19456, timeCost: 2 });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // malformed stored hash must not become a 500 / timing oracle
    }
  }
}
