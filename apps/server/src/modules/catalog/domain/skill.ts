import { type DomainEvent, err, ok, type Result } from '../../../shared-kernel/index.ts';
import { skillArchived, skillMoved, skillRestored, skillVersionCreated } from './events.ts';
import { CatalogError } from './errors.ts';
import type { SkillManifest } from './manifest.ts';
import type { ParsedSkillMd } from './skill-md.ts';
import type { Slug } from './slug.ts';
import type { SkillSource, SourceRef } from './source.ts';

export type SkillStatus = 'active' | 'archived';

export interface SkillVersion {
  readonly number: number;
  readonly name: string;
  readonly description: string;
  readonly manifest: SkillManifest;
  readonly authorId: string;
  readonly message: string | null;
  readonly createdAt: Date;
  readonly restoredFrom: number | null;
  /** The upstream commit this version was taken from; null when it was not. */
  readonly sourceCommit: string | null;
}

type NewContent = {
  skillMd: ParsedSkillMd;
  manifest: SkillManifest;
  authorId: string;
  message: string | null;
  now: Date;
};

export class Skill {
  private events: DomainEvent[] = [];
  /** The folder as the aggregate was loaded: the repository's compare-and-set key. */
  readonly loadedFolderId: string;

  private constructor(
    readonly id: string,
    readonly slug: Slug,
    private currentFolderId: string,
    private currentStatus: SkillStatus,
    private latestVersion: SkillVersion,
    private lastUpdatedAt: Date,
    private currentSource: SkillSource | null,
  ) {
    this.loadedFolderId = currentFolderId;
  }

  static create(
    p: NewContent & {
      id: string;
      slug: Slug;
      folderId: string;
      source: SourceRef | null;
      sourceCommit: string | null;
    },
  ): Result<Skill, CatalogError> {
    if ((p.source === null) !== (p.sourceCommit === null)) {
      return err(new CatalogError('invalid_source', 'source and source commit go together'));
    }
    if (p.skillMd.name !== p.slug.value) return nameMismatch(p.skillMd.name, p.slug);
    const skill = new Skill(
      p.id,
      p.slug,
      p.folderId,
      'active',
      {
        number: 1,
        name: p.skillMd.name,
        description: p.skillMd.description,
        manifest: p.manifest,
        authorId: p.authorId,
        message: p.message,
        createdAt: p.now,
        restoredFrom: null,
        sourceCommit: p.sourceCommit,
      },
      p.now,
      p.source ? { ...p.source, syncedVersion: 1 } : null,
    );
    skill.recordVersion(p.now);
    return ok(skill);
  }

  static rehydrate(state: {
    id: string;
    slug: Slug;
    folderId: string;
    status: SkillStatus;
    latest: SkillVersion;
    updatedAt: Date;
    source: SkillSource | null;
  }): Skill {
    return new Skill(
      state.id,
      state.slug,
      state.folderId,
      state.status,
      state.latest,
      state.updatedAt,
      state.source,
    );
  }

  get folderId(): string {
    return this.currentFolderId;
  }

  /** Where the skill was imported from; null for a skill made in the registry. */
  get source(): SkillSource | null {
    return this.currentSource;
  }

  get status(): SkillStatus {
    return this.currentStatus;
  }

  get latest(): SkillVersion {
    return this.latestVersion;
  }

  get currentVersion(): number {
    return this.latestVersion.number;
  }

  /** When the skill last changed: a new version or a status change. */
  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  /** Can a new version be written on top of `baseVersion`? Same check publish/rollback apply. */
  assertWritable(baseVersion: number): Result<void, CatalogError> {
    const guard = this.guardWrite(baseVersion);
    return guard ? err(guard) : ok(undefined);
  }

  publish(
    p: NewContent & { baseVersion: number; sourceCommit: string | null },
  ): Result<SkillVersion, CatalogError> {
    const guard = this.guardWrite(p.baseVersion);
    if (guard) return err(guard);
    if (p.skillMd.name !== this.slug.value) return nameMismatch(p.skillMd.name, this.slug);
    if (p.sourceCommit !== null && this.currentSource === null) {
      return err(
        new CatalogError(
          'not_imported',
          `skill "${this.slug.value}" was not imported from a source`,
        ),
      );
    }
    const version = this.append({
      name: p.skillMd.name,
      description: p.skillMd.description,
      manifest: p.manifest,
      authorId: p.authorId,
      message: p.message,
      now: p.now,
      restoredFrom: null,
      sourceCommit: p.sourceCommit,
    });
    if (p.sourceCommit !== null && this.currentSource !== null) {
      this.currentSource = { ...this.currentSource, syncedVersion: version.number };
    }
    return ok(version);
  }

  rollback(p: {
    toVersion: SkillVersion;
    baseVersion: number;
    authorId: string;
    now: Date;
  }): Result<SkillVersion, CatalogError> {
    const guard = this.guardWrite(p.baseVersion);
    if (guard) return err(guard);
    return ok(
      this.append({
        name: p.toVersion.name,
        description: p.toVersion.description,
        manifest: p.toVersion.manifest,
        authorId: p.authorId,
        message: `Rollback to version ${p.toVersion.number}`,
        now: p.now,
        restoredFrom: p.toVersion.number,
        sourceCommit: null,
      }),
    );
  }

  // actorId is accepted for audit symmetry; the event payload carries no actor.
  archive(_actorId: string, now: Date): Result<void, CatalogError> {
    if (this.currentStatus === 'active') {
      this.currentStatus = 'archived';
      this.lastUpdatedAt = now;
      this.events.push(skillArchived({ skillId: this.id, slug: this.slug.value }, now));
    }
    return ok(undefined);
  }

  restore(_actorId: string, now: Date): Result<void, CatalogError> {
    if (this.currentStatus === 'archived') {
      this.currentStatus = 'active';
      this.lastUpdatedAt = now;
      this.events.push(skillRestored({ skillId: this.id, slug: this.slug.value }, now));
    }
    return ok(undefined);
  }

  /** Target folder status is checked by the use case. Same folder: ok(false), nothing changes. */
  moveTo(p: { folderId: string; folderSlug: string; now: Date }): Result<boolean, CatalogError> {
    if (this.currentStatus === 'archived') {
      return err(new CatalogError('skill_archived', `skill "${this.slug.value}" is archived`));
    }
    if (p.folderId === this.currentFolderId) return ok(false);
    this.currentFolderId = p.folderId;
    this.lastUpdatedAt = p.now;
    this.events.push(
      skillMoved({ skillId: this.id, slug: this.slug.value, folder: p.folderSlug }, p.now),
    );
    return ok(true);
  }

  pullEvents(): DomainEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private guardWrite(baseVersion: number): CatalogError | null {
    if (this.currentStatus === 'archived') {
      return new CatalogError('skill_archived', `skill "${this.slug.value}" is archived`);
    }
    if (baseVersion !== this.currentVersion) {
      return new CatalogError(
        'version_conflict',
        `base version ${baseVersion} is stale; current is ${this.currentVersion}`,
      );
    }
    return null;
  }

  private append(v: {
    name: string;
    description: string;
    manifest: SkillManifest;
    authorId: string;
    message: string | null;
    now: Date;
    restoredFrom: number | null;
    sourceCommit: string | null;
  }): SkillVersion {
    this.latestVersion = {
      number: this.currentVersion + 1,
      name: v.name,
      description: v.description,
      manifest: v.manifest,
      authorId: v.authorId,
      message: v.message,
      createdAt: v.now,
      restoredFrom: v.restoredFrom,
      sourceCommit: v.sourceCommit,
    };
    this.lastUpdatedAt = v.now;
    this.recordVersion(v.now);
    return this.latestVersion;
  }

  private recordVersion(now: Date): void {
    this.events.push(
      skillVersionCreated(
        { skillId: this.id, slug: this.slug.value, version: this.currentVersion },
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
