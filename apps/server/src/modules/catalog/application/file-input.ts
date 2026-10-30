import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from '../domain/errors.ts';
import { FilePath } from '../domain/file-path.ts';
import { type ManifestEntry, SkillManifest } from '../domain/manifest.ts';
import { type ParsedSkillMd, parseSkillMd } from '../domain/skill-md.ts';
import { MAX_FILE_BYTES, MAX_FILES_PER_SKILL, MAX_SKILL_BYTES } from './limits.ts';
import type { Hasher } from './ports.ts';

export type FileInput = { path: string; bytes: Uint8Array };

/**
 * Entries taken unchanged from the base version's manifest (no bytes, no blob writes).
 * `skillMdText` is the kept SKILL.md's content when SKILL.md is among them.
 */
export type KeptFiles = { entries: ManifestEntry[]; skillMdText: string | null };

const NOTHING_KEPT: KeptFiles = { entries: [], skillMdText: null };

const BINARY_SNIFF_BYTES = 8192;

const limit = (message: string) => err(new CatalogError('limit_exceeded', message));

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0) || decodeUtf8(bytes) === null;
}

/**
 * Validates files, hashes every blob itself (so the key always equals sha256(bytes)) and
 * builds the manifest, with sizes taken from the bytes. `kept` entries join the manifest as
 * they are; limits apply to the combined set and a path in both is a `duplicate_path`.
 */
export function buildVersionInput(
  files: FileInput[],
  hasher: Hasher,
  kept: KeptFiles = NOTHING_KEPT,
): Result<
  { skillMd: ParsedSkillMd; manifest: SkillManifest; blobs: Map<string, Uint8Array> },
  CatalogError
> {
  if (files.length + kept.entries.length > MAX_FILES_PER_SKILL) {
    return limit(`a skill may contain at most ${MAX_FILES_PER_SKILL} files`);
  }
  // Kept entries come from a valid version, so they alone are within the limit.
  let total = kept.entries.reduce((sum, e) => sum + e.size, 0);
  const entries: ManifestEntry[] = [...kept.entries];
  const blobs = new Map<string, Uint8Array>();
  let skillMdText: string | null = kept.skillMdText;

  for (const file of files) {
    const path = FilePath.parse(file.path);
    if (!path.ok) return path;
    const size = file.bytes.length;
    if (size > MAX_FILE_BYTES) {
      return limit(`file "${path.value.value}" exceeds ${MAX_FILE_BYTES} bytes`);
    }
    total += size;
    if (total > MAX_SKILL_BYTES) return limit(`skill exceeds ${MAX_SKILL_BYTES} bytes in total`);

    const hash = hasher.sha256(file.bytes);
    blobs.set(hash.value, file.bytes);
    const binary = isBinary(file.bytes);
    entries.push({ path: path.value, hash, size, binary });
    if (path.value.value === FilePath.SKILL_MD) {
      if (binary) {
        return err(new CatalogError('invalid_frontmatter', 'SKILL.md must be UTF-8 text'));
      }
      skillMdText = decodeUtf8(file.bytes);
    }
  }

  const manifest = SkillManifest.create(entries);
  if (!manifest.ok) return manifest;
  if (skillMdText === null) {
    return err(new CatalogError('missing_skill_md', 'manifest must contain SKILL.md'));
  }
  const skillMd = parseSkillMd(skillMdText);
  if (!skillMd.ok) return skillMd;
  return ok({ skillMd: skillMd.value, manifest: manifest.value, blobs });
}
