import postgres from 'postgres';
import type { Sql, Tx } from '../../../platform/db.ts';
import { appendOutbox } from '../../../platform/outbox.ts';
import type { DomainEvent } from '../../../shared-kernel/index.ts';
import type { SkillListFilter, SkillRepository, SkillSummary } from '../application/ports.ts';
import { ContentHash } from '../domain/content-hash.ts';
import { CatalogError } from '../domain/errors.ts';
import { FilePath } from '../domain/file-path.ts';
import { type ManifestEntry, SkillManifest } from '../domain/manifest.ts';
import { Skill, type SkillStatus, type SkillVersion } from '../domain/skill.ts';
import { Slug } from '../domain/slug.ts';
import type { SkillSource } from '../domain/source.ts';
import { putBlobs } from './pg-blob-store.ts';

interface SkillRow {
  id: string;
  slug: string;
  folder_id: string;
  status: SkillStatus;
  current_version: number;
  updated_at: Date;
  source_host: string | null;
  source_repo: string | null;
  source_path: string | null;
  source_ref: string | null;
  source_synced_version: number | null;
}

interface SummaryRow {
  slug: string;
  name: string;
  description: string;
  status: SkillStatus;
  version: number;
  updated_at: Date;
  folder_slug: string;
  folder_name: string;
}

interface VersionRow {
  number: number;
  name: string;
  description: string;
  author_id: string;
  message: string | null;
  created_at: Date;
  restored_from: number | null;
  source_commit: string | null;
}

interface FileRow {
  path: string;
  hash: string;
  size: number;
  binary: boolean;
}

const VERSION_CREATED = 'catalog.skill_version_created';
const ARCHIVED = 'catalog.skill_archived';
const RESTORED = 'catalog.skill_restored';
const MOVED = 'catalog.skill_moved';
const UNIQUE_VIOLATION = '23505';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

export class PgSkillRepository implements SkillRepository {
  constructor(private readonly sql: Sql) {}

  async findBySlug(slug: Slug): Promise<Skill | null> {
    const [row] = await this.sql<SkillRow[]>`
      select s.id, s.slug, s.folder_id, s.status, s.current_version, s.updated_at,
        src.host as source_host, src.repo as source_repo, src.path as source_path,
        src.ref as source_ref, src.synced_version as source_synced_version
      from catalog.skills s left join catalog.skill_sources src on src.skill_id = s.id
      where s.slug = ${slug.value}`;
    return row ? this.hydrate(row) : null;
  }

  async findById(id: string): Promise<Skill | null> {
    const [row] = await this.sql<SkillRow[]>`
      select s.id, s.slug, s.folder_id, s.status, s.current_version, s.updated_at,
        src.host as source_host, src.repo as source_repo, src.path as source_path,
        src.ref as source_ref, src.synced_version as source_synced_version
      from catalog.skills s left join catalog.skill_sources src on src.skill_id = s.id
      where s.id = ${id}`;
    return row ? this.hydrate(row) : null;
  }

  // Scoped by skillId: this is the guard that a rollback target belongs to the skill.
  async getVersion(skillId: string, n: number): Promise<SkillVersion | null> {
    const [row] = await this.sql<VersionRow[]>`
      select number, name, description, author_id, message, created_at, restored_from,
        source_commit
      from catalog.skill_versions where skill_id = ${skillId} and number = ${n}`;
    return row ? this.toVersion(skillId, row) : null;
  }

  async listVersions(skillId: string): Promise<SkillVersion[]> {
    const rows = await this.sql<VersionRow[]>`
      select number, name, description, author_id, message, created_at, restored_from,
        source_commit
      from catalog.skill_versions where skill_id = ${skillId} order by number`;
    return Promise.all(rows.map((r) => this.toVersion(skillId, r)));
  }

  // One statement (no fragments, no per-row hydration): the list page must not be N+1.
  async listSummaries(filter: SkillListFilter): Promise<SkillSummary[]> {
    const only = filter.status === 'all' ? null : filter.status;
    const rows = await this.sql<SummaryRow[]>`
      select s.slug, v.name, v.description, s.status, s.current_version as version, s.updated_at,
        f.slug as folder_slug, f.name as folder_name
      from catalog.skills s
      join catalog.skill_versions v on v.skill_id = s.id and v.number = s.current_version
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
    }));
  }

  async listActiveInFolder(folderId: string): Promise<Skill[]> {
    const rows = await this.sql<SkillRow[]>`
      select s.id, s.slug, s.folder_id, s.status, s.current_version, s.updated_at,
        src.host as source_host, src.repo as source_repo, src.path as source_path,
        src.ref as source_ref, src.synced_version as source_synced_version
      from catalog.skills s left join catalog.skill_sources src on src.skill_id = s.id
      where s.folder_id = ${folderId} and s.status = 'active' order by s.slug`;
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async save(skill: Skill, blobs: Map<string, Uint8Array>): Promise<void> {
    try {
      await this.sql.begin((tx) => writeSkill(tx, skill, blobs));
    } catch (cause) {
      throw this.translate(cause, skill);
    }
  }

  private translate(cause: unknown, skill: Skill): unknown {
    if (cause instanceof postgres.PostgresError && cause.code === UNIQUE_VIOLATION) {
      if (cause.constraint_name === 'skills_slug_key') {
        return new CatalogError('skill_exists', `skill "${skill.slug.value}" already exists`);
      }
      // PK (skill_id, number): second line of defence against concurrent publishes.
      if (cause.constraint_name === 'skill_versions_pkey') return conflict(skill);
    }
    return cause;
  }

  private async hydrate(row: SkillRow): Promise<Skill> {
    const latest = await this.getVersion(row.id, row.current_version);
    if (!latest) throw new Error(`skill ${row.id} has no version ${row.current_version}`);
    return Skill.rehydrate({
      id: row.id,
      slug: unwrap(Slug.parse(row.slug)),
      folderId: row.folder_id,
      status: row.status,
      latest,
      updatedAt: row.updated_at,
      source: toSource(row),
    });
  }

  private async toVersion(skillId: string, row: VersionRow): Promise<SkillVersion> {
    const files = await this.sql<FileRow[]>`
      select path, hash, size, "binary" from catalog.version_files
      where skill_id = ${skillId} and number = ${row.number} order by path collate "C"`;
    const entries: ManifestEntry[] = files.map((f) => ({
      path: unwrap(FilePath.parse(f.path)),
      hash: unwrap(ContentHash.parse(f.hash)),
      size: f.size,
      binary: f.binary,
    }));
    return {
      number: row.number,
      name: row.name,
      description: row.description,
      manifest: unwrap(SkillManifest.create(entries)),
      authorId: row.author_id,
      message: row.message,
      createdAt: row.created_at,
      restoredFrom: row.restored_from,
      sourceCommit: row.source_commit,
    };
  }
}

/**
 * Writes the skill's state and drains its events into the outbox, inside `tx`. Shared by save and
 * PgFolderRepository.archiveWithSkills. A skill that becomes active somewhere (created, restored or
 * moved) first takes its folder row `for share`, so a concurrent folder archive either waits for
 * this write (and then sees the skill) or wins (and this write sees the folder archived).
 */
export async function writeSkill(
  tx: Tx,
  skill: Skill,
  blobs: Map<string, Uint8Array>,
): Promise<void> {
  const events = skill.pullEvents();
  const newVersion = events.some(
    (e) => e.type === VERSION_CREATED && e.payload['version'] === skill.currentVersion,
  );
  const placed =
    (newVersion && skill.currentVersion === 1) ||
    events.some((e) => e.type === RESTORED || e.type === MOVED);
  if (skill.status === 'active' && placed) await lockFolder(tx, skill.folderId);
  if (newVersion) {
    await putBlobs(tx, blobs);
    await writeVersion(tx, skill);
  } else {
    await writeState(tx, skill, events);
  }
  await appendOutbox(tx, events);
}

async function lockFolder(tx: Tx, folderId: string): Promise<void> {
  const [folder] = await tx<{ slug: string; status: string }[]>`
    select slug, status from catalog.folders where id = ${folderId} for share`;
  if (!folder) throw new CatalogError('folder_not_found', `folder ${folderId} not found`);
  if (folder.status !== 'active') {
    throw new CatalogError('folder_archived', `folder "${folder.slug}" is archived`);
  }
}

/**
 * Status and folder changes (no new version): one CAS on the status the aggregate was loaded with
 * (before its first archive/restore, else the current one), on the folder it was loaded with
 * and on its version.
 */
async function writeState(tx: Tx, skill: Skill, events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  const first = events.find((e) => e.type === ARCHIVED || e.type === RESTORED);
  const previous: SkillStatus = first
    ? first.type === ARCHIVED
      ? 'active'
      : 'archived'
    : skill.status;
  const updated = await tx`update catalog.skills
    set status = ${skill.status}, folder_id = ${skill.folderId}, updated_at = ${skill.updatedAt}
    where id = ${skill.id} and status = ${previous} and folder_id = ${skill.loadedFolderId}
      and current_version = ${skill.currentVersion}`;
  if (updated.count !== 1) throw conflict(skill);
}

async function writeVersion(tx: Tx, skill: Skill): Promise<void> {
  const v = skill.latest;
  if (v.number === 1) {
    await tx`insert into catalog.skills (id, slug, folder_id, status, current_version, updated_at)
      values (${skill.id}, ${skill.slug.value}, ${skill.folderId}, ${skill.status}, 1,
        ${skill.updatedAt})`;
  } else {
    const updated = await tx`update catalog.skills
      set current_version = ${v.number}, updated_at = ${skill.updatedAt}
      where id = ${skill.id} and current_version = ${v.number - 1} and status = 'active'`;
    if (updated.count !== 1) throw conflict(skill);
  }
  await tx`insert into catalog.skill_versions
    (skill_id, number, name, description, author_id, message, created_at, restored_from,
      source_commit)
    values (${skill.id}, ${v.number}, ${v.name}, ${v.description}, ${v.authorId},
      ${v.message}, ${v.createdAt}, ${v.restoredFrom}, ${v.sourceCommit})`;
  // The source changes only with the first version or a sync from upstream (a sourceCommit).
  const src = skill.source;
  if (src && (v.number === 1 || v.sourceCommit !== null)) {
    await tx`insert into catalog.skill_sources (skill_id, host, repo, path, ref, synced_version)
      values (${skill.id}, ${src.host}, ${src.repo}, ${src.path}, ${src.ref}, ${src.syncedVersion})
      on conflict (skill_id) do update set host = excluded.host, repo = excluded.repo,
        path = excluded.path, ref = excluded.ref, synced_version = excluded.synced_version`;
  }
  const files = JSON.stringify(
    v.manifest.entries.map((e) => ({
      path: e.path.value,
      hash: e.hash.value,
      size: e.size,
      binary: e.binary,
    })),
  );
  await tx`insert into catalog.version_files (skill_id, number, path, hash, size, "binary")
    select ${skill.id}::uuid, ${v.number}::int, x.path, x.hash, x.size, x."binary"
    from jsonb_to_recordset(${files}::text::jsonb)
      as x(path text, hash text, size int, "binary" boolean)`;
}

function toSource(row: SkillRow): SkillSource | null {
  if (row.source_repo === null || row.source_synced_version === null) return null;
  const host = row.source_host;
  if (host !== 'github.com') throw new Error(`unknown source host ${JSON.stringify(host)}`);
  return {
    host,
    repo: row.source_repo,
    path: row.source_path ?? '',
    ref: row.source_ref,
    syncedVersion: row.source_synced_version,
  };
}

function conflict(skill: Skill): CatalogError {
  return new CatalogError(
    'version_conflict',
    `skill "${skill.slug.value}" was modified concurrently`,
  );
}
