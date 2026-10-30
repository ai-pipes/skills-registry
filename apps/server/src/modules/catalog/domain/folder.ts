import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';
import { Slug } from './slug.ts';

export type FolderStatus = 'active' | 'archived';

const MAX_FOLDER_NAME = 100;
const MAX_FOLDER_DESCRIPTION = 1000;

type Fields = { name: string; description: string };

function validate(p: Fields): Result<Fields, CatalogError> {
  const name = p.name.trim();
  const description = p.description.trim();
  if (name.length < 1 || name.length > MAX_FOLDER_NAME) {
    return err(
      new CatalogError('invalid_folder', `folder name must be 1-${MAX_FOLDER_NAME} characters`),
    );
  }
  if (description.length < 1 || description.length > MAX_FOLDER_DESCRIPTION) {
    return err(
      new CatalogError(
        'invalid_folder',
        `folder description must be 1-${MAX_FOLDER_DESCRIPTION} characters`,
      ),
    );
  }
  return ok({ name, description });
}

export class Folder {
  private constructor(
    readonly id: string,
    readonly slug: Slug,
    private currentName: string,
    private currentDescription: string,
    private currentStatus: FolderStatus,
    readonly createdAt: Date,
    private lastUpdatedAt: Date,
  ) {}

  static create(p: {
    id: string;
    slug: Slug;
    name: string;
    description: string;
    now: Date;
  }): Result<Folder, CatalogError> {
    if (Slug.isReserved(p.slug)) return err(Slug.reservedError(p.slug, 'folder'));
    const v = validate(p);
    if (!v.ok) return v;
    return ok(new Folder(p.id, p.slug, v.value.name, v.value.description, 'active', p.now, p.now));
  }

  static rehydrate(s: {
    id: string;
    slug: Slug;
    name: string;
    description: string;
    status: FolderStatus;
    createdAt: Date;
    updatedAt: Date;
  }): Folder {
    return new Folder(s.id, s.slug, s.name, s.description, s.status, s.createdAt, s.updatedAt);
  }

  get name(): string {
    return this.currentName;
  }

  get description(): string {
    return this.currentDescription;
  }

  get status(): FolderStatus {
    return this.currentStatus;
  }

  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  /** ok(false) when nothing changed. Allowed for an archived folder too. */
  edit(p: { name: string; description: string; now: Date }): Result<boolean, CatalogError> {
    const v = validate(p);
    if (!v.ok) return v;
    if (v.value.name === this.currentName && v.value.description === this.currentDescription) {
      return ok(false);
    }
    this.currentName = v.value.name;
    this.currentDescription = v.value.description;
    this.lastUpdatedAt = p.now;
    return ok(true);
  }

  archive(now: Date): boolean {
    return this.setStatus('archived', now);
  }

  restore(now: Date): boolean {
    return this.setStatus('active', now);
  }

  private setStatus(status: FolderStatus, now: Date): boolean {
    if (this.currentStatus === status) return false;
    this.currentStatus = status;
    this.lastUpdatedAt = now;
    return true;
  }
}
