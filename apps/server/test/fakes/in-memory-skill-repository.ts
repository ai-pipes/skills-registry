import type {
  BlobStore,
  SkillListFilter,
  SkillRepository,
  SkillSummary,
} from '../../src/modules/catalog/application/ports.ts';
import type { ContentHash } from '../../src/modules/catalog/domain/content-hash.ts';
import { CatalogError } from '../../src/modules/catalog/domain/errors.ts';
import type { Folder } from '../../src/modules/catalog/domain/folder.ts';
import {
  Skill,
  type SkillStatus,
  type SkillVersion,
} from '../../src/modules/catalog/domain/skill.ts';
import type { SkillSource } from '../../src/modules/catalog/domain/source.ts';
import type { Slug } from '../../src/modules/catalog/domain/slug.ts';
import type { DomainEvent } from '../../src/shared-kernel/index.ts';

type Row = {
  id: string;
  slug: Slug;
  folderId: string;
  status: SkillStatus;
  versions: SkillVersion[];
  updatedAt: Date;
  source: SkillSource | null;
};

/** What the skill repository needs from the folder fake: the Pg join and `for share` check. */
export interface FolderLookup {
  byId(id: string): Folder | undefined;
}

const VERSION_CREATED = 'catalog.skill_version_created';
const ARCHIVED = 'catalog.skill_archived';
const RESTORED = 'catalog.skill_restored';
const MOVED = 'catalog.skill_moved';

/** Mirrors PgSkillRepository semantics: drains events on save, CAS on version and status. */
export class InMemorySkillRepository implements SkillRepository, BlobStore {
  private readonly rows = new Map<string, Row>();
  private readonly blobs = new Map<string, Uint8Array>();
  private folders: FolderLookup | null = null;
  /** Every blob hash handed to save(), in order: shows which content was (re-)uploaded. */
  readonly blobWrites: string[] = [];
  /** Events of every successful write, in order (the outbox). */
  readonly outbox: DomainEvent[] = [];

  /** Called by InMemoryFolderRepository: save checks folders, summaries carry folder refs. */
  attachFolders(folders: FolderLookup): void {
    this.folders = folders;
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    return this.blobs.get(hash.value) ?? null;
  }

  async findBySlug(slug: Slug): Promise<Skill | null> {
    const row = [...this.rows.values()].find((r) => r.slug.equals(slug));
    return row ? this.hydrate(row) : null;
  }

  async findById(id: string): Promise<Skill | null> {
    const row = this.rows.get(id);
    return row ? this.hydrate(row) : null;
  }

  async getVersion(skillId: string, n: number): Promise<SkillVersion | null> {
    return this.rows.get(skillId)?.versions.find((v) => v.number === n) ?? null;
  }

  async listVersions(skillId: string): Promise<SkillVersion[]> {
    return [...(this.rows.get(skillId)?.versions ?? [])];
  }

  async listSummaries(filter: SkillListFilter): Promise<SkillSummary[]> {
    return [...this.rows.values()]
      .filter((r) => filter.status === 'all' || r.status === filter.status)
      .map((r) => ({ r, folder: this.folder(r.folderId) }))
      .filter(({ folder }) => filter.folder === null || folder.slug.value === filter.folder)
      .toSorted((a, b) => a.r.slug.value.localeCompare(b.r.slug.value))
      .map(({ r, folder }) => {
        const latest = r.versions.at(-1)!;
        return {
          slug: r.slug.value,
          name: latest.name,
          description: latest.description,
          status: r.status,
          version: latest.number,
          updatedAt: r.updatedAt,
          folder: { slug: folder.slug.value, name: folder.name },
        };
      });
  }

  async listActiveInFolder(folderId: string): Promise<Skill[]> {
    return [...this.rows.values()]
      .filter((r) => r.folderId === folderId && r.status === 'active')
      .map((r) => this.hydrate(r));
  }

  /** Statuses of the skills in a folder (the folder fake's counts). */
  statusesIn(folderId: string): SkillStatus[] {
    return [...this.rows.values()].filter((r) => r.folderId === folderId).map((r) => r.status);
  }

  /** Ids of the active skills in a folder (the folder fake's `for update` check). */
  activeIdsIn(folderId: string): string[] {
    return [...this.rows.values()]
      .filter((r) => r.folderId === folderId && r.status === 'active')
      .map((r) => r.id);
  }

  async save(skill: Skill, blobs: Map<string, Uint8Array>): Promise<void> {
    const events = skill.pullEvents();
    this.check(skill, events);
    this.write(skill, events, blobs);
    this.outbox.push(...events);
  }

  /** Throws what PgSkillRepository's save would, before anything is written. */
  check(skill: Skill, events: DomainEvent[]): void {
    const created = isNewVersion(skill, events);
    const row = this.rows.get(skill.id);
    const v = skill.latest;
    if (created && v.number === 1) {
      if ([...this.rows.values()].some((r) => r.slug.equals(skill.slug))) {
        throw new CatalogError('skill_exists', `skill "${skill.slug.value}" already exists`);
      }
    } else if (created) {
      if (!row || row.versions.length !== v.number - 1 || row.status !== 'active') {
        throw conflict(skill);
      }
    } else if (events.length > 0) {
      const first = events.find((e) => e.type === ARCHIVED || e.type === RESTORED);
      const previous: SkillStatus = first
        ? first.type === ARCHIVED
          ? 'active'
          : 'archived'
        : skill.status;
      if (
        !row ||
        row.status !== previous ||
        row.folderId !== skill.loadedFolderId ||
        row.versions.length !== skill.currentVersion
      ) {
        throw conflict(skill);
      }
    }
    const placed =
      (created && v.number === 1) || events.some((e) => e.type === RESTORED || e.type === MOVED);
    if (skill.status === 'active' && placed) this.checkFolder(skill.folderId);
  }

  /** Writes a skill checked by `check`. */
  write(skill: Skill, events: DomainEvent[], blobs: Map<string, Uint8Array>): void {
    const row = this.rows.get(skill.id);
    if (isNewVersion(skill, events)) {
      const v = skill.latest;
      if (v.number === 1 || !row) {
        this.rows.set(skill.id, {
          id: skill.id,
          slug: skill.slug,
          folderId: skill.folderId,
          status: skill.status,
          versions: [v],
          updatedAt: skill.updatedAt,
          source: skill.source,
        });
      } else {
        row.versions.push(v);
        row.updatedAt = skill.updatedAt;
        row.source = skill.source;
      }
      for (const [hash, bytes] of blobs) {
        this.blobWrites.push(hash);
        this.blobs.set(hash, bytes);
      }
      return;
    }
    if (events.length === 0 || !row) return;
    row.status = skill.status;
    row.folderId = skill.folderId;
    row.updatedAt = skill.updatedAt;
  }

  private checkFolder(folderId: string): void {
    const folder = this.folders?.byId(folderId);
    if (!folder) throw new CatalogError('folder_not_found', `folder ${folderId} not found`);
    if (folder.status === 'archived') {
      throw new CatalogError('folder_archived', `folder "${folder.slug.value}" is archived`);
    }
  }

  private folder(id: string): Folder {
    const folder = this.folders?.byId(id);
    if (!folder) throw new Error(`folder ${id} is missing`);
    return folder;
  }

  private hydrate(row: Row): Skill {
    const latest = row.versions.at(-1);
    if (!latest) throw new Error('row without versions');
    return Skill.rehydrate({
      id: row.id,
      slug: row.slug,
      folderId: row.folderId,
      status: row.status,
      latest,
      updatedAt: row.updatedAt,
      source: row.source,
    });
  }
}

const isNewVersion = (skill: Skill, events: DomainEvent[]) =>
  events.some((e) => e.type === VERSION_CREATED && e.payload['version'] === skill.currentVersion);

const conflict = (skill: Skill) =>
  new CatalogError('version_conflict', `skill "${skill.slug.value}" was modified concurrently`);
