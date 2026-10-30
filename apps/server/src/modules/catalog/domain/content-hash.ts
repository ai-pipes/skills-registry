import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';

const HASH_RE = /^[0-9a-f]{64}$/;

/** Holds a precomputed sha256 hex digest; hashing itself is done by the Hasher port. */
export class ContentHash {
  private constructor(readonly value: string) {}

  static parse(hex: string): Result<ContentHash, CatalogError> {
    if (!HASH_RE.test(hex)) {
      return err(
        new CatalogError('invalid_path', 'content hash must be 64 lowercase hex characters'),
      );
    }
    return ok(new ContentHash(hex));
  }

  equals(other: ContentHash): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
