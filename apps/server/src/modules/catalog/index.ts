import type { Sql } from '../../platform/db.ts';
import type { CatalogDeps } from './application/deps.ts';
import { PgBlobStore } from './infrastructure/pg-blob-store.ts';
import { PgFolderRepository } from './infrastructure/pg-folder-repository.ts';
import { PgSkillRepository } from './infrastructure/pg-skill-repository.ts';

export { archiveSkill, restoreSkill } from './application/commands/archive.ts';
export { createSkill } from './application/commands/create-skill.ts';
export {
  archiveFolder,
  createFolder,
  restoreFolder,
  updateFolder,
} from './application/commands/folders.ts';
export { moveSkill } from './application/commands/move-skill.ts';
export { publishVersion } from './application/commands/publish-version.ts';
export { rollbackSkill } from './application/commands/rollback.ts';
export type { CatalogDeps } from './application/deps.ts';
export type { FileInput } from './application/file-input.ts';
export type { FolderRef, FolderSummary } from './application/ports.ts';
export { diffVersions, type FileDiff } from './application/queries/diff.ts';
export { getSkillFile } from './application/queries/get-file.ts';
export { getSkill, type SkillView } from './application/queries/get-skill.ts';
export { getHistory, type VersionSummary } from './application/queries/history.ts';
export { listFolders } from './application/queries/list-folders.ts';
export { listSkills, type SkillSummary } from './application/queries/list-skills.ts';
export { CatalogError, type CatalogErrorCode } from './domain/errors.ts';
export { nodeHasher } from './infrastructure/node-hasher.ts';

export function createPgCatalog(sql: Sql): Pick<CatalogDeps, 'skills' | 'blobs' | 'folders'> {
  return {
    skills: new PgSkillRepository(sql),
    blobs: new PgBlobStore(sql),
    folders: new PgFolderRepository(sql),
  };
}
