import type {
  SubagentListFilter,
  SubagentRepository,
  SubagentSummary,
} from '../../src/modules/catalog/application/ports.ts';
import { CatalogError } from '../../src/modules/catalog/domain/errors.ts';
import type { Folder } from '../../src/modules/catalog/domain/folder.ts';
import type { Slug } from '../../src/modules/catalog/domain/slug.ts';
import {
  Subagent,
  type SubagentStatus,
  type SubagentVersion,
} from '../../src/modules/catalog/domain/subagent.ts';
import type { DomainEvent } from '../../src/shared-kernel/index.ts';
import type { FolderLookup } from './in-memory-skill-repository.ts';

type Row = {
  id: string;
  slug: Slug;
  folderId: string;
  status: SubagentStatus;
  versions: SubagentVersion[];
  updatedAt: Date;
};

const VERSION_CREATED = 'catalog.subagent_version_created';
const ARCHIVED = 'catalog.subagent_archived';
const RESTORED = 'catalog.subagent_restored';
const MOVED = 'catalog.subagent_moved';

/** Mirrors PgSubagentRepository semantics: drains events on save, CAS on version, status, folder. */
export class InMemorySubagentRepository implements SubagentRepository {
  private readonly rows = new Map<string, Row>();
  private folders: FolderLookup | null = null;
  /** The SUBAGENT.md blobs handed to save(), by hash hex. */
  readonly blobs = new Map<string, Uint8Array>();
  /** Events of every successful write, in order (the outbox). */
  readonly outbox: DomainEvent[] = [];

  /** Called by InMemoryFolderRepository: save checks folders, summaries carry folder refs. */
  attachFolders(folders: FolderLookup): void {
    this.folders = folders;
  }

  async findBySlug(slug: Slug): Promise<Subagent | null> {
    const row = [...this.rows.values()].find((r) => r.slug.equals(slug));
    return row ? hydrate(row) : null;
  }

  async findById(id: string): Promise<Subagent | null> {
    const row = this.rows.get(id);
    return row ? hydrate(row) : null;
  }

  async getVersion(subagentId: string, n: number): Promise<SubagentVersion | null> {
    return this.rows.get(subagentId)?.versions.find((v) => v.number === n) ?? null;
  }

  async listVersions(subagentId: string): Promise<SubagentVersion[]> {
    return [...(this.rows.get(subagentId)?.versions ?? [])];
  }

  async listSummaries(filter: SubagentListFilter): Promise<SubagentSummary[]> {
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
          model: latest.model,
          tools: latest.tools === null ? null : [...latest.tools],
          skills: [...latest.skills],
        };
      });
  }

  async listActiveInFolder(folderId: string): Promise<Subagent[]> {
    return [...this.rows.values()]
      .filter((r) => r.folderId === folderId && r.status === 'active')
      .toSorted((a, b) => a.slug.value.localeCompare(b.slug.value))
      .map(hydrate);
  }

  async usedBy(skillSlug: string): Promise<string[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'active' && r.versions.at(-1)!.skills.includes(skillSlug))
      .map((r) => r.slug.value)
      .toSorted();
  }

  /** Ids of the active subagents in a folder (the folder fake's `for update` check). */
  activeIdsIn(folderId: string): string[] {
    return [...this.rows.values()]
      .filter((r) => r.folderId === folderId && r.status === 'active')
      .map((r) => r.id);
  }

  async save(subagent: Subagent, blobs: Map<string, Uint8Array>): Promise<void> {
    const events = subagent.pullEvents();
    this.check(subagent, events);
    this.write(subagent, events, blobs);
    this.outbox.push(...events);
  }

  /** Throws what PgSubagentRepository's save would, before anything is written. */
  check(subagent: Subagent, events: DomainEvent[]): void {
    const created = isNewVersion(subagent, events);
    const row = this.rows.get(subagent.id);
    const v = subagent.latest;
    if (created && v.number === 1) {
      if ([...this.rows.values()].some((r) => r.slug.equals(subagent.slug))) {
        throw new CatalogError(
          'subagent_exists',
          `subagent "${subagent.slug.value}" already exists`,
        );
      }
    } else if (created) {
      if (!row || row.versions.length !== v.number - 1 || row.status !== 'active') {
        throw conflict(subagent);
      }
    } else if (events.length > 0) {
      const first = events.find((e) => e.type === ARCHIVED || e.type === RESTORED);
      const previous: SubagentStatus = first
        ? first.type === ARCHIVED
          ? 'active'
          : 'archived'
        : subagent.status;
      if (
        !row ||
        row.status !== previous ||
        row.folderId !== subagent.loadedFolderId ||
        row.versions.length !== subagent.currentVersion
      ) {
        throw conflict(subagent);
      }
    }
    const placed =
      (created && v.number === 1) || events.some((e) => e.type === RESTORED || e.type === MOVED);
    if (subagent.status === 'active' && placed) this.checkFolder(subagent.folderId);
  }

  /** Writes a subagent checked by `check`. */
  write(subagent: Subagent, events: DomainEvent[], blobs: Map<string, Uint8Array>): void {
    const row = this.rows.get(subagent.id);
    if (isNewVersion(subagent, events)) {
      const v = subagent.latest;
      if (v.number === 1 || !row) {
        this.rows.set(subagent.id, {
          id: subagent.id,
          slug: subagent.slug,
          folderId: subagent.folderId,
          status: subagent.status,
          versions: [v],
          updatedAt: subagent.updatedAt,
        });
      } else {
        row.versions.push(v);
        row.updatedAt = subagent.updatedAt;
      }
      for (const [hash, bytes] of blobs) this.blobs.set(hash, bytes);
      return;
    }
    if (events.length === 0 || !row) return;
    row.status = subagent.status;
    row.folderId = subagent.folderId;
    row.updatedAt = subagent.updatedAt;
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
}

function hydrate(row: Row): Subagent {
  const latest = row.versions.at(-1);
  if (!latest) throw new Error('row without versions');
  return Subagent.rehydrate({
    id: row.id,
    slug: row.slug,
    folderId: row.folderId,
    status: row.status,
    latest,
    updatedAt: row.updatedAt,
  });
}

const isNewVersion = (subagent: Subagent, events: DomainEvent[]) =>
  events.some(
    (e) => e.type === VERSION_CREATED && e.payload['version'] === subagent.currentVersion,
  );

const conflict = (subagent: Subagent) =>
  new CatalogError(
    'version_conflict',
    `subagent "${subagent.slug.value}" was modified concurrently`,
  );
