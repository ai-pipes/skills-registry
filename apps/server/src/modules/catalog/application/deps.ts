import type { AuditLog, Clock } from '../../../shared-kernel/index.ts';
import type { BlobStore, FolderRepository, Hasher, IdGenerator, SkillRepository } from './ports.ts';

export type CatalogDeps = {
  skills: SkillRepository;
  folders: FolderRepository;
  blobs: BlobStore;
  hasher: Hasher;
  ids: IdGenerator;
  clock: Clock;
  audit: AuditLog;
};
