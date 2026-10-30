import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import type { ContentHash } from './content-hash.ts';
import { CatalogError } from './errors.ts';
import { FilePath } from './file-path.ts';

export type ManifestEntry = {
  path: FilePath;
  hash: ContentHash;
  size: number;
  binary: boolean;
};

export class SkillManifest {
  private readonly byPath: Map<string, ManifestEntry>;

  private constructor(readonly entries: readonly ManifestEntry[]) {
    this.byPath = new Map(entries.map((e) => [e.path.value, e]));
  }

  static create(entries: ManifestEntry[]): Result<SkillManifest, CatalogError> {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = entry.path.value.toLowerCase();
      if (seen.has(key)) {
        return err(new CatalogError('duplicate_path', `duplicate path: ${entry.path.value}`));
      }
      seen.add(key);
    }
    if (!entries.some((e) => e.path.value === FilePath.SKILL_MD)) {
      return err(new CatalogError('missing_skill_md', 'manifest must contain SKILL.md'));
    }
    return ok(new SkillManifest([...entries]));
  }

  get totalSize(): number {
    return this.entries.reduce((sum, e) => sum + e.size, 0);
  }

  get(path: FilePath): ManifestEntry | undefined {
    return this.byPath.get(path.value);
  }
}
