import postgres from 'postgres';
import type { Sql, Tx } from '../../../platform/db.ts';
import { appendOutbox } from '../../../platform/outbox.ts';
import type { DomainEvent } from '../../../shared-kernel/index.ts';
import type {
  SubagentListFilter,
  SubagentRepository,
  SubagentSummary,
} from '../application/ports.ts';
import { ContentHash } from '../domain/content-hash.ts';
import { CatalogError } from '../domain/errors.ts';
import { Slug } from '../domain/slug.ts';
import type { SubagentModel } from '../domain/subagent-md.ts';
import { Subagent, type SubagentStatus, type SubagentVersion } from '../domain/subagent.ts';
import { putBlobs } from './pg-blob-store.ts';
import { lockFolder } from './pg-skill-repository.ts';

interface SubagentRow {
  id: string;
  slug: string;
  folder_id: string;
  status: SubagentStatus;
  current_version: number;
  updated_at: Date;
}

interface SummaryRow {
  slug: string;
  name: string;
  description: string;
  status: SubagentStatus;
  version: number;
  updated_at: Date;
  folder_slug: string;
  folder_name: string;
  model: SubagentModel;
  tools: string[] | null;
  skills: string[];
}

interface VersionRow {
  number: number;
  name: string;
  description: string;
  tools: string[] | null;
  model: SubagentModel;
  skills: string[];
  content_hash: string;
  size: number;
  author_id: string;
  message: string | null;
  created_at: Date;
  restored_from: number | null;
}

const VERSION_CREATED = 'catalog.subagent_version_created';
const ARCHIVED = 'catalog.subagent_archived';
const RESTORED = 'catalog.subagent_restored';
const MOVED = 'catalog.subagent_moved';
const UNIQUE_VIOLATION = '23505';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

export class PgSubagentRepository implements SubagentRepository {
  constructor(private readonly sql: Sql) {}

  async findBySlug(slug: Slug): Promise<Subagent | null> {
    const [row] = await this.sql<SubagentRow[]>`
      select id, slug, folder_id, status, current_version, updated_at
      from catalog.subagents where slug = ${slug.value}`;
    return row ? this.hydrate(row) : null;
  }

  async findById(id: string): Promise<Subagent | null> {
    const [row] = await this.sql<SubagentRow[]>`
      select id, slug, folder_id, status, current_version, updated_at
      from catalog.subagents where id = ${id}`;
    return row ? this.hydrate(row) : null;
  }

  // Scoped by subagentId: this is the guard that a rollback target belongs to the subagent.
  async getVersion(subagentId: string, n: number): Promise<SubagentVersion | null> {
    const [row] = await this.sql<VersionRow[]>`
      select number, name, description, tools, model, skills, content_hash, size, author_id,
        message, created_at, restored_from
      from catalog.subagent_versions where subagent_id = ${subagentId} and number = ${n}`;
    return row ? toVersion(row) : null;
  }

  async listVersions(subagentId: string): Promise<SubagentVersion[]> {
    const rows = await this.sql<VersionRow[]>`
      select number, name, description, tools, model, skills, content_hash, size, author_id,
        message, created_at, restored_from
      from catalog.subagent_versions where subagent_id = ${subagentId} order by number`;
    return rows.map(toVersion);
  }

  // One statement: the list page must not be N+1.
  async listSummaries(filter: SubagentListFilter): Promise<SubagentSummary[]> {
    const only = filter.status === 'all' ? null : filter.status;
    const rows = await this.sql<SummaryRow[]>`
      select s.slug, v.name, v.description, s.status, s.current_version as version, s.updated_at,
        f.slug as folder_slug, f.name as folder_name, v.model, v.tools, v.skills
      from catalog.subagents s
      join catalog.subagent_versions v on v.subagent_id = s.id and v.number = s.current_version
      join catalog.folders f on f.id = s.folder_id
      where (${only}::text is null or s.status = ${only}::text)
        and (${filter.folder}::text is null or f.slug = ${filter.folder}::text)
      order by s.slug`;
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      status: r.status,
      version: r.version,
      updatedAt: r.updated_at,
      folder: { slug: r.folder_slug, name: r.folder_name },
      model: r.model,
      tools: r.tools,
      skills: r.skills,
    }));
  }

  async listActiveInFolder(folderId: string): Promise<Subagent[]> {
    const rows = await this.sql<SubagentRow[]>`
      select id, slug, folder_id, status, current_version, updated_at
      from catalog.subagents
      where folder_id = ${folderId} and status = 'active' order by slug`;
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async usedBy(skillSlug: string): Promise<string[]> {
    const rows = await this.sql<{ slug: string }[]>`
      select s.slug from catalog.subagents s
      join catalog.subagent_versions v on v.subagent_id = s.id and v.number = s.current_version
      where s.status = 'active' and v.skills @> array[${skillSlug}::text]
      order by s.slug`;
    return rows.map((r) => r.slug);
  }

  async save(subagent: Subagent, blobs: Map<string, Uint8Array>): Promise<void> {
    try {
      await this.sql.begin((tx) => writeSubagent(tx, subagent, blobs));
    } catch (cause) {
      throw translate(cause, subagent);
    }
  }

  private async hydrate(row: SubagentRow): Promise<Subagent> {
    const latest = await this.getVersion(row.id, row.current_version);
    if (!latest) throw new Error(`subagent ${row.id} has no version ${row.current_version}`);
    return Subagent.rehydrate({
      id: row.id,
      slug: unwrap(Slug.parse(row.slug)),
      folderId: row.folder_id,
      status: row.status,
      latest,
      updatedAt: row.updated_at,
    });
  }
}

/**
 * Writes the subagent's state and drains its events into the outbox, inside `tx`. Shared by save
 * and PgFolderRepository.archiveWithSkills. As for skills, a subagent that becomes active somewhere
 * (created, restored or moved) first takes its folder row `for share`.
 */
export async function writeSubagent(
  tx: Tx,
  subagent: Subagent,
  blobs: Map<string, Uint8Array>,
): Promise<void> {
  const events = subagent.pullEvents();
  const newVersion = events.some(
    (e) => e.type === VERSION_CREATED && e.payload['version'] === subagent.currentVersion,
  );
  const placed =
    (newVersion && subagent.currentVersion === 1) ||
    events.some((e) => e.type === RESTORED || e.type === MOVED);
  if (subagent.status === 'active' && placed) await lockFolder(tx, subagent.folderId);
  if (newVersion) {
    await putBlobs(tx, blobs);
    await writeVersion(tx, subagent);
  } else {
    await writeState(tx, subagent, events);
  }
  await appendOutbox(tx, events);
}

/** CAS on the status the aggregate was loaded with, the folder it was loaded with and its version. */
async function writeState(tx: Tx, subagent: Subagent, events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  const first = events.find((e) => e.type === ARCHIVED || e.type === RESTORED);
  const previous: SubagentStatus = first
    ? first.type === ARCHIVED
      ? 'active'
      : 'archived'
    : subagent.status;
  const updated = await tx`update catalog.subagents
    set status = ${subagent.status}, folder_id = ${subagent.folderId},
      updated_at = ${subagent.updatedAt}
    where id = ${subagent.id} and status = ${previous} and folder_id = ${subagent.loadedFolderId}
      and current_version = ${subagent.currentVersion}`;
  if (updated.count !== 1) throw conflict(subagent);
}

async function writeVersion(tx: Tx, subagent: Subagent): Promise<void> {
  const v = subagent.latest;
  if (v.number === 1) {
    await tx`insert into catalog.subagents (id, slug, folder_id, status, current_version, updated_at)
      values (${subagent.id}, ${subagent.slug.value}, ${subagent.folderId}, ${subagent.status}, 1,
        ${subagent.updatedAt})`;
  } else {
    const updated = await tx`update catalog.subagents
      set current_version = ${v.number}, updated_at = ${subagent.updatedAt}
      where id = ${subagent.id} and current_version = ${v.number - 1} and status = 'active'`;
    if (updated.count !== 1) throw conflict(subagent);
  }
  await tx`insert into catalog.subagent_versions
    (subagent_id, number, name, description, tools, model, skills, content_hash, size, author_id,
      message, created_at, restored_from)
    values (${subagent.id}, ${v.number}, ${v.name}, ${v.description},
      ${v.tools === null ? null : tx.array([...v.tools])}::text[], ${v.model},
      ${tx.array([...v.skills])}::text[], ${v.contentHash.value}, ${v.size}, ${v.authorId},
      ${v.message}, ${v.createdAt}, ${v.restoredFrom})`;
}

function toVersion(row: VersionRow): SubagentVersion {
  return {
    number: row.number,
    name: row.name,
    description: row.description,
    tools: row.tools,
    model: row.model,
    skills: row.skills,
    contentHash: unwrap(ContentHash.parse(row.content_hash)),
    size: row.size,
    authorId: row.author_id,
    message: row.message,
    createdAt: row.created_at,
    restoredFrom: row.restored_from,
  };
}

/** Maps the unique keys of save's transaction to catalog errors. */
function translate(cause: unknown, subagent: Subagent): unknown {
  if (cause instanceof postgres.PostgresError && cause.code === UNIQUE_VIOLATION) {
    if (cause.constraint_name === 'subagents_slug_key') {
      return new CatalogError(
        'subagent_exists',
        `subagent "${subagent.slug.value}" already exists`,
      );
    }
    // PK (subagent_id, number): second line of defence against concurrent publishes.
    if (cause.constraint_name === 'subagent_versions_pkey') return conflict(subagent);
  }
  return cause;
}

function conflict(subagent: Subagent): CatalogError {
  return new CatalogError(
    'version_conflict',
    `subagent "${subagent.slug.value}" was modified concurrently`,
  );
}
