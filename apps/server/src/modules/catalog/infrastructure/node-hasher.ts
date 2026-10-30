import { createHash } from 'node:crypto';
import type { Hasher } from '../application/ports.ts';
import { ContentHash } from '../domain/content-hash.ts';

export const nodeHasher: Hasher = {
  sha256(bytes) {
    const parsed = ContentHash.parse(createHash('sha256').update(bytes).digest('hex'));
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  },
};
