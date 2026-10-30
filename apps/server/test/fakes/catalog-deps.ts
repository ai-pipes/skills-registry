import type { CatalogDeps } from '../../src/modules/catalog/application/deps.ts';
import { Folder } from '../../src/modules/catalog/domain/folder.ts';
import { Slug } from '../../src/modules/catalog/domain/slug.ts';
import { FixedClock } from './fixed-clock.ts';
import { InMemoryFolderRepository } from './in-memory-folder-repository.ts';
import { InMemorySkillRepository } from './in-memory-skill-repository.ts';
import { SeqIds } from './seq-ids.ts';
import { shaHasher } from './sha-hasher.ts';

export type Audited = {
  actorId: string | null;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
};

const GENERAL_FOLDER_ID = 'folder-general';

/** In-memory Catalog with the default active folder `general`, as after migrations 0006 and 0009. */
export function makeCatalogDeps(): {
  deps: CatalogDeps;
  skills: InMemorySkillRepository;
  folders: InMemoryFolderRepository;
  audit: Audited[];
  clock: FixedClock;
} {
  const skills = new InMemorySkillRepository();
  const folders = new InMemoryFolderRepository(skills);
  const audit: Audited[] = [];
  const clock = new FixedClock();
  const slug = Slug.parse('general');
  if (!slug.ok) throw slug.error;
  const general = Folder.create({
    id: GENERAL_FOLDER_ID,
    slug: slug.value,
    name: 'General',
    description: 'General skills without a specific topic',
    now: clock.now(),
  });
  if (!general.ok) throw general.error;
  void folders.save(general.value);
  const deps: CatalogDeps = {
    skills,
    folders,
    blobs: skills,
    hasher: shaHasher,
    ids: new SeqIds(),
    clock,
    audit: {
      record: async (e) => {
        audit.push(e);
      },
    },
  };
  return { deps, skills, folders, audit, clock };
}
