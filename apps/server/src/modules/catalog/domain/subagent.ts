import { type DomainEvent, err, ok, type Result } from '../../../shared-kernel/index.ts';
import type { ContentHash } from './content-hash.ts';
import { CatalogError } from './errors.ts';
import {
  subagentArchived,
  subagentMoved,
  subagentRestored,
  subagentVersionCreated,
} from './events.ts';
import type { Slug } from './slug.ts';
import type { ParsedSubagentMd, SubagentModel } from './subagent-md.ts';

export type SubagentStatus = 'active' | 'archived';

export interface SubagentVersion {
  readonly number: number;
  readonly name: string;
  readonly description: string;
  /** null: inherit every tool. */
  readonly tools: readonly string[] | null;
  readonly model: SubagentModel;
  readonly skills: readonly string[];
  /** The SUBAGENT.md blob. */
  readonly contentHash: ContentHash;
  readonly size: number;
  readonly authorId: string;
  readonly message: string | null;
  readonly createdAt: Date;
  readonly restoredFrom: number | null;
}

type NewContent = {
  md: ParsedSubagentMd;
  contentHash: ContentHash;
  size: number;
  authorId: string;
  message: string | null;
  now: Date;
};

export class Subagent {
  private events: DomainEvent[] = [];
  /** The folder as the aggregate was loaded: the repository's compare-and-set key. */
  readonly loadedFolderId: string;

  private constructor(
    readonly id: string,
    readonly slug: Slug,
    private currentFolderId: string,
    private currentStatus: SubagentStatus,
    private latestVersion: SubagentVersion,
    private lastUpdatedAt: Date,
  ) {
    this.loadedFolderId = currentFolderId;
  }

  static create(
    p: NewContent & { id: string; slug: Slug; folderId: string },
  ): Result<Subagent, CatalogError> {
    if (p.md.name !== p.slug.value) return nameMismatch(p.md.name, p.slug);
    const subagent = new Subagent(
      p.id,
      p.slug,
      p.folderId,
      'active',
      {
        number: 1,
        name: p.md.name,
        description: p.md.description,
        tools: p.md.tools && [...p.md.tools],
        model: p.md.model,
        skills: [...p.md.skills],
        contentHash: p.contentHash,
        size: p.size,
        authorId: p.authorId,
        message: p.message,
        createdAt: p.now,
        restoredFrom: null,
      },
      p.now,
    );
    subagent.recordVersion(p.now);
    return ok(subagent);
  }

  static rehydrate(state: {
    id: string;
    slug: Slug;
    folderId: string;
    status: SubagentStatus;
    latest: SubagentVersion;
    updatedAt: Date;
  }): Subagent {
    return new Subagent(
      state.id,
      state.slug,
      state.folderId,
      state.status,
      state.latest,
      state.updatedAt,
    );
  }

  get folderId(): string {
    return this.currentFolderId;
  }

  get status(): SubagentStatus {
    return this.currentStatus;
  }

  get latest(): SubagentVersion {
    return this.latestVersion;
  }

  get currentVersion(): number {
    return this.latestVersion.number;
  }

  /** When the subagent last changed: a new version, a move or a status change. */
  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  /** Can a new version be written on top of `baseVersion`? Same check publish/rollback apply. */
  assertWritable(baseVersion: number): Result<void, CatalogError> {
    const guard = this.guardWrite(baseVersion);
    return guard ? err(guard) : ok(undefined);
  }

  publish(p: NewContent & { baseVersion: number }): Result<SubagentVersion, CatalogError> {
    const guard = this.guardWrite(p.baseVersion);
    if (guard) return err(guard);
    if (p.md.name !== this.slug.value) return nameMismatch(p.md.name, this.slug);
    return ok(
      this.append({
        name: p.md.name,
        description: p.md.description,
        tools: p.md.tools && [...p.md.tools],
        model: p.md.model,
        skills: [...p.md.skills],
        contentHash: p.contentHash,
        size: p.size,
        authorId: p.authorId,
        message: p.message,
        now: p.now,
        restoredFrom: null,
      }),
    );
  }

  rollback(p: {
    toVersion: SubagentVersion;
    baseVersion: number;
    authorId: string;
    now: Date;
  }): Result<SubagentVersion, CatalogError> {
    const guard = this.guardWrite(p.baseVersion);
    if (guard) return err(guard);
    const t = p.toVersion;
    return ok(
      this.append({
        name: t.name,
        description: t.description,
        tools: t.tools,
        model: t.model,
        skills: t.skills,
        contentHash: t.contentHash,
        size: t.size,
        authorId: p.authorId,
        message: `Rollback to version ${t.number}`,
        now: p.now,
        restoredFrom: t.number,
      }),
    );
  }

  archive(now: Date): Result<void, CatalogError> {
    if (this.currentStatus === 'active') {
      this.currentStatus = 'archived';
      this.lastUpdatedAt = now;
      this.events.push(subagentArchived({ subagentId: this.id, slug: this.slug.value }, now));
    }
    return ok(undefined);
  }

  restore(now: Date): Result<void, CatalogError> {
    if (this.currentStatus === 'archived') {
      this.currentStatus = 'active';
      this.lastUpdatedAt = now;
      this.events.push(subagentRestored({ subagentId: this.id, slug: this.slug.value }, now));
    }
    return ok(undefined);
  }

  /** Target folder status is checked by the use case. Same folder: ok(false), nothing changes. */
  moveTo(p: { folderId: string; folderSlug: string; now: Date }): Result<boolean, CatalogError> {
    if (this.currentStatus === 'archived') {
      return err(new CatalogError('subagent_archived', this.archivedMessage()));
    }
    if (p.folderId === this.currentFolderId) return ok(false);
    this.currentFolderId = p.folderId;
    this.lastUpdatedAt = p.now;
    this.events.push(
      subagentMoved({ subagentId: this.id, slug: this.slug.value, folder: p.folderSlug }, p.now),
    );
    return ok(true);
  }

  pullEvents(): DomainEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private archivedMessage(): string {
    return `subagent "${this.slug.value}" is archived`;
  }

  private guardWrite(baseVersion: number): CatalogError | null {
    if (this.currentStatus === 'archived') {
      return new CatalogError('subagent_archived', this.archivedMessage());
    }
    if (baseVersion !== this.currentVersion) {
      return new CatalogError(
        'version_conflict',
        `base version ${baseVersion} is stale; current is ${this.currentVersion}`,
      );
    }
    return null;
  }

  private append(
    v: Omit<SubagentVersion, 'number' | 'createdAt'> & { now: Date },
  ): SubagentVersion {
    const { now, ...content } = v;
    this.latestVersion = { ...content, number: this.currentVersion + 1, createdAt: now };
    this.lastUpdatedAt = now;
    this.recordVersion(now);
    return this.latestVersion;
  }

  private recordVersion(now: Date): void {
    this.events.push(
      subagentVersionCreated(
        { subagentId: this.id, slug: this.slug.value, version: this.currentVersion },
        now,
      ),
    );
  }
}

function nameMismatch(name: string, slug: Slug) {
  return err(
    new CatalogError('name_mismatch', `frontmatter name "${name}" must equal slug "${slug.value}"`),
  );
}
