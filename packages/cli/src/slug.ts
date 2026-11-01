import { UsageError } from './args.ts';

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A kebab-case slug (it becomes a file or directory name); anything else is a usage error. */
export function checkSlug(slug: string, noun = 'skill'): string {
  if (!SLUG_RE.test(slug)) throw new UsageError(`invalid ${noun} slug "${slug}"`);
  return slug;
}
