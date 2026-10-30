import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';

const MAX_PATH = 255;
const MAX_SEGMENT = 100;

const invalid = (message: string) => err(new CatalogError('invalid_path', message));

export class FilePath {
  static readonly SKILL_MD = 'SKILL.md';

  private constructor(readonly value: string) {}

  static parse(raw: string): Result<FilePath, CatalogError> {
    if (raw.includes('\0')) return invalid('path contains NUL');
    const segments: string[] = [];
    for (const segment of raw.replaceAll('\\', '/').split('/')) {
      if (segment === '') continue;
      // a leading "./" is stripped; "." anywhere else is rejected
      if (segment === '.' && segments.length === 0) continue;
      if (segment === '.' || segment === '..') return invalid('path contains "." or ".." segment');
      if (segment.length > MAX_SEGMENT) return invalid(`path segment exceeds ${MAX_SEGMENT}`);
      segments.push(segment);
    }
    if (segments.length === 0) return invalid('path is empty');
    const value = segments.join('/');
    if (value.length > MAX_PATH) return invalid(`path exceeds ${MAX_PATH} characters`);
    return ok(new FilePath(value));
  }

  equals(other: FilePath): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
