import postgres from 'postgres';
import type { Sql } from '../../../platform/db.ts';
import type { FolderRepository, FolderSummary } from '../application/ports.ts';
import { CatalogError } from '../domain/errors.ts';
import { Folder, type FolderStatus } from '../domain/folder.ts';
import type { Skill } from '../domain/skill.ts';
import { Slug } from '../domain/slug.ts';
import { writeSkill } from './pg-skill-repository.ts';

interface FolderRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: FolderStatus;
  created_at: Date;
  updated_at: Date;
}

interface SummaryRow {
  slug: string;
  name: string;
  description: string;
  status: FolderStatus;
  active: number;
  archived: number;
}

const UNIQUE_VIOLATION = '23505';

export class PgFolderRepository implements FolderRepository {
  constructor(private readonly sql: Sql) {}

  async findBySlug(slug: Slug): Promise<Folder | null> {
    const [row] = await this.sql<FolderRow[]>`
      select id, slug, name, description, status, created_at, updated_at
      from catalog.folders where slug = ${slug.value}`;
    return row ? hydrate(row) : null;
  }

  async findById(id: string): Promise<Folder | null> {
    const [row] = await this.sql<FolderRow[]>`
      select id, slug, name, description, status, created_at, updated_at
      from catalog.folders where id = ${id}`;
    return row ? hydrate(row) : null;
  }

  async list(status: FolderStatus | 'all'): Promise<FolderSummary[]> {
    const only = status === 'all' ? null : status;
    const rows = await this.sql<SummaryRow[]>`
      select f.slug, f.name, f.description, f.status,
        count(s.id) filter (where s.status = 'active')::int as active,
        count(s.id) filter (where s.status = 'archived')::int as archived
      from catalog.folders f
      left join catalog.skills s on s.folder_id = f.id
      where ${only}::text is null or f.status = ${only}::text
      group by f.id
      order by f.name, f.slug`;
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      status: r.status,
      skills: { active: r.active, archived: r.archived },
    }));
  }

  // CAS on the status the folder was loaded with: a stale edit or restore racing archiveWithSkills
  // (or another restore) writes nothing, so only archiveWithSkills archives and only restore restores.
  async save(folder: Folder, loadedStatus: FolderStatus = folder.status): Promise<void> {
    try {
      const written = await this.sql`
        insert into catalog.folders (id, slug, name, description, status, created_at, updated_at)
        values (${folder.id}, ${folder.slug.value}, ${folder.name}, ${folder.description},
          ${folder.status}, ${folder.createdAt}, ${folder.updatedAt})
        on conflict (id) do update set
          name = excluded.name, description = excluded.description,
          status = excluded.status, updated_at = excluded.updated_at
        where catalog.folders.status = ${loadedStatus}`;
      if (written.count !== 1) throw conflict(folder);
    } catch (cause) {
      if (
        cause instanceof postgres.PostgresError &&
        cause.code === UNIQUE_VIOLATION &&
        cause.constraint_name === 'folders_slug_key'
      ) {
        throw new CatalogError('folder_exists', `folder "${folder.slug.value}" already exists`);
      }
      throw cause;
    }
  }

  async archiveWithSkills(folder: Folder, skills: Skill[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Waits for writes holding the folder `for share` (create, move, restore into it).
      const [row] = await tx<{ status: FolderStatus }[]>`
        select status from catalog.folders where id = ${folder.id} for update`;
      if (row?.status !== 'active') throw conflict(folder);
      const active = await tx<{ id: string }[]>`
        select id from catalog.skills
        where folder_id = ${folder.id} and status = 'active' for update`;
      const expected = active.map((r) => r.id).toSorted();
      const given = skills.map((s) => s.id).toSorted();
      if (expected.join() !== given.join()) throw conflict(folder);
      await tx`update catalog.folders set status = ${folder.status}, updated_at = ${folder.updatedAt}
        where id = ${folder.id}`;
      // Sequential: one transaction runs one statement at a time.
      await skills.reduce(async (prev, skill) => {
        await prev;
        await writeSkill(tx, skill, new Map());
      }, Promise.resolve());
    });
  }
}

function hydrate(row: FolderRow): Folder {
  const slug = Slug.parse(row.slug);
  if (!slug.ok) throw slug.error;
  return Folder.rehydrate({
    id: row.id,
    slug: slug.value,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function conflict(folder: Folder): CatalogError {
  return new CatalogError(
    'version_conflict',
    `folder "${folder.slug.value}" was modified concurrently`,
  );
}
