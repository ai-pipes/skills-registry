import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_LENGTH = 64;
/**
 * `/skills/new` is the web UI's new-skill page, so no new skill may be called that.
 * Only creation checks it: `parse` stays permissive, so a skill stored with such a
 * slug before the reservation can still be loaded, archived and indexed.
 */
const RESERVED = new Set(['new']);

export class Slug {
  private constructor(readonly value: string) {}

  static parse(raw: string): Result<Slug, CatalogError> {
    if (raw.length < 1 || raw.length > MAX_LENGTH || !SLUG_RE.test(raw)) {
      return err(
        new CatalogError('invalid_slug', `slug must be kebab-case, 1-${MAX_LENGTH} characters`),
      );
    }
    return ok(new Slug(raw));
  }

  static isReserved(slug: Slug): boolean {
    return RESERVED.has(slug.value);
  }

  /** The error creation returns for a reserved slug; `kind` names the clashing page. */
  static reservedError(slug: Slug, kind: 'skill' | 'folder' = 'skill'): CatalogError {
    return new CatalogError(
      'invalid_slug',
      `slug "${slug.value}" is reserved: /${kind}s/${slug.value} is the new-${kind} page`,
    );
  }

  equals(other: Slug): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
