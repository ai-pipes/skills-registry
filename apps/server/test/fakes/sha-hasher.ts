import { createHash } from 'node:crypto';
import type { Hasher } from '../../src/modules/catalog/application/ports.ts';
import { ContentHash } from '../../src/modules/catalog/domain/content-hash.ts';

export const shaHasher: Hasher = {
  sha256(bytes) {
    const parsed = ContentHash.parse(createHash('sha256').update(bytes).digest('hex'));
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  },
};
