import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';
import { FilePath } from './file-path.ts';

/** Where an imported skill lives upstream: a folder (`''` = the root) of a public GitHub repo. */
export type SourceRef = { host: 'github.com'; repo: string; path: string; ref: string | null };

/** A skill's source plus the last version taken from upstream. */
export type SkillSource = SourceRef & { syncedVersion: number };

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_REPO = 200;
const MAX_REF = 255;
const COMMIT = /^[0-9a-f]{40}$/;

const invalid = (message: string) => err(new CatalogError('invalid_source', message));

/** Whitespace, C0 controls and DEL are not allowed in a ref. */
function badRefChar(ref: string): boolean {
  for (const ch of ref) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || c === 0x7f || /\s/u.test(ch)) return true;
  }
  return false;
}

export function parseSourceRef(raw: {
  host: string;
  repo: string;
  path: string;
  ref: string | null;
}): Result<SourceRef, CatalogError> {
  if (raw.host !== 'github.com') return invalid('source host must be github.com');
  if (raw.repo.length > MAX_REPO || !REPO.test(raw.repo)) {
    return invalid('source repo must be "<owner>/<repo>"');
  }
  let path = '';
  if (raw.path !== '') {
    const parsed = FilePath.parse(raw.path);
    if (!parsed.ok) return invalid(`source path is invalid: ${parsed.error.message}`);
    path = parsed.value.value;
  }
  if (
    raw.ref !== null &&
    (raw.ref.length === 0 || raw.ref.length > MAX_REF || badRefChar(raw.ref))
  ) {
    return invalid(`source ref must be 1-${MAX_REF} characters without spaces`);
  }
  return ok({ host: 'github.com', repo: raw.repo, path, ref: raw.ref });
}

export function parseSourceCommit(raw: string): Result<string, CatalogError> {
  return COMMIT.test(raw) ? ok(raw) : invalid('source commit must be 40 lowercase hex characters');
}
