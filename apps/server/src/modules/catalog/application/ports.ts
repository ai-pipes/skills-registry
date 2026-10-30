import type { ContentHash } from '../domain/content-hash.ts';
import type { Folder, FolderStatus } from '../domain/folder.ts';
import type { Skill, SkillStatus, SkillVersion } from '../domain/skill.ts';
import type { Slug } from '../domain/slug.ts';

/** A folder as a skill shows it: its slug and current name. */
export type FolderRef = { slug: string; name: string };

/** One row of the skill list: the skill and its current version's name/description. */
export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  status: SkillStatus;
  version: number;
  /** The skill row's last change: a new version, archive, restore or move. */
  updatedAt: Date;
  folder: FolderRef;
};

/** `folder` is a folder slug; null means every folder. */
export type SkillListFilter = { status: SkillStatus | 'all'; folder: string | null };

/** One row of the folder list, with the number of skills in it. */
export type FolderSummary = {
  slug: string;
  name: string;
  description: string;
  status: FolderStatus;
  skills: { active: number; archived: number };
};

export interface SkillRepository {
  findBySlug(slug: Slug): Promise<Skill | null>;
  findById(id: string): Promise<Skill | null>;
  getVersion(skillId: string, n: number): Promise<SkillVersion | null>;
  listVersions(skillId: string): Promise<SkillVersion[]>;
  /** Summaries ordered by slug, in a single query (joined with folders); never loads manifests or blobs. */
  listSummaries(filter: SkillListFilter): Promise<SkillSummary[]>;
  listActiveInFolder(folderId: string): Promise<Skill[]>;
  /**
   * Persists the aggregate in one transaction. Drains the aggregate's events (they go to the outbox),
   * so after a failed save the caller must reload the skill before retrying.
   * When the saved skill is active and the save creates, restores or moves it, the same transaction
   * locks its folder row `for share`: a missing folder throws CatalogError folder_not_found, an
   * archived one folder_archived (so a skill never lands active in a folder being archived).
   */
  save(skill: Skill, blobs: Map<string, Uint8Array>): Promise<void>;
}

export interface FolderRepository {
  findBySlug(slug: Slug): Promise<Folder | null>;
  findById(id: string): Promise<Folder | null>;
  /** Ordered by name, then slug; skill counts come from the same query. */
  list(status: FolderStatus | 'all'): Promise<FolderSummary[]>;
  /**
   * Upsert by id. A taken slug throws CatalogError folder_exists. An existing row is written only
   * while its status is still `loadedStatus` (default: the folder's own status, i.e. an edit), else
   * version_conflict: a stale edit never flips the status back, and archiving goes only through
   * archiveWithSkills.
   */
  save(folder: Folder, loadedStatus?: FolderStatus): Promise<void>;
  /**
   * One transaction: locks the folder row `for update` (it must still be active) and the ids of its
   * active skills `for update`, which must equal the ids of `skills`, else CatalogError
   * version_conflict. Writes the folder and the skills (CAS on status and current version) and
   * appends every skill's events to the outbox.
   */
  archiveWithSkills(folder: Folder, skills: Skill[]): Promise<void>;
}

export interface BlobStore {
  get(hash: ContentHash): Promise<Uint8Array | null>;
}

export interface Hasher {
  sha256(bytes: Uint8Array): ContentHash;
}

/** @public Consumed by application use cases in later tasks. */
export interface IdGenerator {
  uuid(): string;
}
