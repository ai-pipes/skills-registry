import type {
  FolderRepository,
  FolderSummary,
} from '../../src/modules/catalog/application/ports.ts';
import { CatalogError } from '../../src/modules/catalog/domain/errors.ts';
import { Folder, type FolderStatus } from '../../src/modules/catalog/domain/folder.ts';
import type { Skill } from '../../src/modules/catalog/domain/skill.ts';
import type { Slug } from '../../src/modules/catalog/domain/slug.ts';
import type { FolderLookup, InMemorySkillRepository } from './in-memory-skill-repository.ts';

const copy = (f: Folder) =>
  Folder.rehydrate({
    id: f.id,
    slug: f.slug,
    name: f.name,
    description: f.description,
    status: f.status,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  });

/** Mirrors PgFolderRepository; attaches itself to `skills` so their save checks the folder. */
export class InMemoryFolderRepository implements FolderRepository, FolderLookup {
  private readonly rows = new Map<string, Folder>();

  constructor(private readonly skills: InMemorySkillRepository) {
    skills.attachFolders(this);
  }

  byId(id: string): Folder | undefined {
    return this.rows.get(id);
  }

  async findBySlug(slug: Slug): Promise<Folder | null> {
    const row = [...this.rows.values()].find((f) => f.slug.equals(slug));
    return row ? copy(row) : null;
  }

  async findById(id: string): Promise<Folder | null> {
    const row = this.rows.get(id);
    return row ? copy(row) : null;
  }

  async list(status: FolderStatus | 'all'): Promise<FolderSummary[]> {
    return [...this.rows.values()]
      .filter((f) => status === 'all' || f.status === status)
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.slug.value.localeCompare(b.slug.value))
      .map((f) => {
        const statuses = this.skills.statusesIn(f.id);
        return {
          slug: f.slug.value,
          name: f.name,
          description: f.description,
          status: f.status,
          skills: {
            active: statuses.filter((s) => s === 'active').length,
            archived: statuses.filter((s) => s === 'archived').length,
          },
        };
      });
  }

  async save(folder: Folder, loadedStatus: FolderStatus = folder.status): Promise<void> {
    const clash = [...this.rows.values()].find(
      (f) => f.slug.equals(folder.slug) && f.id !== folder.id,
    );
    if (clash) {
      throw new CatalogError('folder_exists', `folder "${folder.slug.value}" already exists`);
    }
    const row = this.rows.get(folder.id);
    if (row && row.status !== loadedStatus) throw conflict(folder);
    this.rows.set(folder.id, copy(folder));
  }

  async archiveWithSkills(folder: Folder, skills: Skill[]): Promise<void> {
    const row = this.rows.get(folder.id);
    if (!row || row.status !== 'active') throw conflict(folder);
    const expected = this.skills.activeIdsIn(folder.id).toSorted();
    const given = skills.map((s) => s.id).toSorted();
    if (expected.join() !== given.join()) throw conflict(folder);
    const events = skills.map((s) => s.pullEvents());
    skills.forEach((s, i) => this.skills.check(s, events[i]!));
    skills.forEach((s, i) => this.skills.write(s, events[i]!, new Map()));
    this.skills.outbox.push(...events.flat());
    this.rows.set(folder.id, copy(folder));
  }
}

const conflict = (folder: Folder) =>
  new CatalogError('version_conflict', `folder "${folder.slug.value}" was modified concurrently`);
