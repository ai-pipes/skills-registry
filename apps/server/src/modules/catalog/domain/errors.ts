import { DomainError } from '../../../shared-kernel/index.ts';

export type CatalogErrorCode =
  | 'invalid_slug'
  | 'invalid_path'
  | 'invalid_frontmatter'
  | 'missing_skill_md'
  | 'name_mismatch'
  | 'duplicate_path'
  | 'version_conflict'
  | 'skill_not_found'
  | 'file_not_found'
  | 'skill_archived'
  | 'skill_exists'
  | 'limit_exceeded'
  | 'version_not_found'
  | 'folder_not_found'
  | 'folder_exists'
  | 'folder_archived'
  | 'invalid_folder'
  | 'invalid_source'
  | 'not_imported';

export class CatalogError extends DomainError {
  declare readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(code, message);
    this.name = 'CatalogError';
  }
}
