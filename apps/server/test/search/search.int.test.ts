import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  archiveFolder,
  archiveSkill,
  type CatalogDeps,
  createFolder,
  createPgCatalog,
  createSkill,
  getSkill,
  moveSkill,
} from '../../src/modules/catalog/index.ts';
import { buildVersionInput } from '../../src/modules/catalog/application/file-input.ts';
import { Skill } from '../../src/modules/catalog/domain/skill.ts';
import { Slug } from '../../src/modules/catalog/domain/slug.ts';
import {
  createCatalogSkillReader,
  createPgSearch,
  indexMissingEmbeddings,
  indexSkill,
  reindexAll,
  type SearchDeps,
  searchEventHandlers,
  searchSkills,
} from '../../src/modules/search/index.ts';
import { PgSearchIndex } from '../../src/modules/search/infrastructure/pg-search-index.ts';
import { PgAuditLog } from '../../src/platform/audit.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { FixedClock } from '../fakes/fixed-clock.ts';
import { shaHasher } from '../fakes/sha-hasher.ts';
import { GENERAL_FOLDER_ID, startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let catalog: CatalogDeps;
let embedder: FakeEmbedder;
let search: SearchDeps;

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  catalog = {
    ...createPgCatalog(pg.sql),
    hasher: shaHasher,
    ids: { uuid: () => randomUUID() },
    clock: new FixedClock(),
    audit: new PgAuditLog(pg.sql),
  };
  embedder = new FakeEmbedder();
  search = {
    ...createPgSearch(pg.sql),
    embedder,
    skills: createCatalogSkillReader(catalog),
    // FakeEmbedder vectors are bags of hashed tokens: unrelated texts have similarity ~0.
    minSimilarity: 0.3,
  };
});

const ACTOR = randomUUID();
const enc = (s: string) => new TextEncoder().encode(s);

async function addSkill(
  slug: string,
  description: string,
  body = 'Instructions.',
  folder = 'general',
) {
  const res = await createSkill(catalog, {
    slug,
    folder,
    files: [
      {
        path: 'SKILL.md',
        bytes: enc(`---\nname: ${slug}\ndescription: ${description}\n---\n${body}\n`),
      },
    ],
    actorId: ACTOR,
    message: null,
    source: null,
    sourceCommit: null,
  });
  if (!res.ok) throw res.error;
  await indexSkill(search, { slug });
}

const slugs = async (query: string, limit = 10) =>
  (await searchSkills(search, { query, limit })).map((r) => r.slug);

// Russian descriptions and queries are deliberate: they check full-text search on Cyrillic
// (including other word forms) next to English, as the registry serves both languages.
describe('searchSkills (Postgres)', () => {
  beforeEach(async () => {
    await addSkill('code-review', 'Проводит ревью кода перед мержем');
    await addSkill('pdf', 'Extract text and tables from PDF files', 'Use pdftotext.');
    await addSkill('borscht', 'Рецепт борща со свёклой');
  });

  it('finds a Russian description by another word form (Review Focus 2)', async () => {
    expect((await slugs('ревью кода'))[0]).toBe('code-review');
    expect((await slugs('ревьюить код'))[0]).toBe('code-review');
  });

  it('finds an English skill by an English query', async () => {
    expect((await slugs('extract text from pdf'))[0]).toBe('pdf');
  });

  it('returns nothing for an unrelated query (no text match, similarity below the floor)', async () => {
    expect(await searchSkills(search, { query: 'погода завтра', limit: 10 })).toEqual([]);
  });

  it('scores in 0..1: 1 only for the top hit of both lists', async () => {
    const res = await searchSkills(search, { query: 'pdf', limit: 10 });
    expect(res[0]).toMatchObject({ slug: 'pdf', score: 1 });
    expect(res[0]?.description).toBe('Extract text and tables from PDF files');
    expect(res.every((r) => r.score > 0 && r.score <= 1)).toBe(true);
  });

  it('scores a text-only hit the same whether or not the embedder is ready', async () => {
    const notReady = new FakeEmbedder();
    notReady.ready = async () => false;
    const off = await searchSkills(
      { ...search, embedder: notReady },
      { query: 'tables', limit: 10 },
    );
    expect(off.map((r) => [r.slug, r.score])).toEqual([['pdf', 0.5]]);
    const on = await searchSkills(search, { query: 'tables', limit: 10 });
    expect(on.find((r) => r.slug === 'pdf')?.score).toBe(0.5);
  });

  it('sweep skips a poison document for an hour and fills in the others', async () => {
    await addSkill('ok1', 'desc ok1');
    await addSkill('a-poison', 'desc a-poison');
    await addSkill('ok2', 'desc ok2');
    await pg.sql`update search.documents set embedding = null where slug in ('ok1', 'a-poison', 'ok2')`;
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      if (texts.some((t) => t.includes('desc a-poison'))) throw new Error('a-poison');
      return real(texts);
    };
    const embedded = async () =>
      (
        await pg.sql<{ slug: string }[]>`
          select slug from search.documents where embedding is not null order by slug`
      ).map((r) => r.slug);

    expect(await indexMissingEmbeddings(search, { limit: 20 })).toEqual({
      indexed: ['ok1', 'ok2'],
      failed: ['a-poison'],
      stoppedEarly: null,
    });
    expect(await embedded()).toEqual(['borscht', 'code-review', 'ok1', 'ok2', 'pdf']);
    const calls = embedder.calls;
    expect((await indexMissingEmbeddings(search, { limit: 20 })).failed).toEqual([]);
    expect(embedder.calls).toBe(calls);

    await pg.sql`update search.documents set embed_failed_at = now() - interval '2 hours'
      where slug = 'a-poison'`;
    // Retried after the hour; alone in the batch it is not provably isolated, so not re-marked.
    expect((await indexMissingEmbeddings(search, { limit: 20 })).failed).toEqual(['a-poison']);

    embedder.embedPassages = real;
    await pg.sql`update search.documents set embed_failed_at = now() - interval '2 hours'
      where slug = 'a-poison'`;
    expect((await indexMissingEmbeddings(search, { limit: 20 })).indexed).toEqual(['a-poison']);
    const [row] =
      await pg.sql`select embed_failed_at from search.documents where slug = 'a-poison'`;
    expect(row?.['embed_failed_at']).toBeNull();
  });

  it('sweep: three poison documents sorting first do not starve the rest', async () => {
    await addSkill('a-p1', 'desc a-p1');
    await addSkill('a-p2', 'desc a-p2');
    await addSkill('a-p3', 'desc a-p3');
    await addSkill('b-ok', 'desc b-ok');
    await pg.sql`update search.documents set embedding = null where slug like 'a-p%' or slug = 'b-ok'`;
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      if (texts.some((t) => t.includes('desc a-p'))) throw new Error('poison');
      return real(texts);
    };
    expect(await indexMissingEmbeddings(search, { limit: 20 })).toEqual({
      indexed: ['b-ok'],
      failed: ['a-p1', 'a-p2', 'a-p3'],
      stoppedEarly: null,
    });
    const marked = await pg.sql`select slug from search.documents
      where embed_failed_at is not null order by slug`;
    expect(marked.map((r) => r['slug'])).toEqual(['a-p1', 'a-p2', 'a-p3']);
  });

  it('sweep: a never-attempted document goes before a retried one', async () => {
    await addSkill('a-old', 'desc a-old');
    await addSkill('z-new', 'desc z-new');
    await pg.sql`update search.documents set embedding = null where slug in ('a-old', 'z-new')`;
    await pg.sql`update search.documents set embed_failed_at = now() - interval '2 hours'
      where slug = 'a-old'`;
    expect(await search.index.slugsWithoutEmbedding(10)).toEqual(['z-new', 'a-old']);
  });

  it('stores an embedding next to the FTS vector', async () => {
    const [row] = await pg.sql<{ dims: number }[]>`
      select vector_dims(embedding) as dims from search.documents where slug = 'pdf'`;
    expect(row?.dims).toBe(384);
  });

  it('does not find an archived skill', async () => {
    const res = await archiveSkill(catalog, { slug: 'pdf', actorId: ACTOR });
    if (!res.ok) throw res.error;
    await indexSkill(search, { slug: 'pdf' });
    expect(await slugs('extract text from pdf')).not.toContain('pdf');
    expect(await slugs('pdf')).not.toContain('pdf');
  });

  it('returns FTS results when the embedder fails (Review Focus 4)', async () => {
    embedder.failing = true;
    expect(await slugs('ревью кода')).toEqual(['code-review']);
    expect(await slugs('ревьюить код')).toEqual(['code-review']);
    expect(await slugs('extract text from pdf')).toEqual(['pdf']);
  });

  it('respects limit and ignores a blank query', async () => {
    expect(await slugs('pdf', 1)).toHaveLength(1);
    expect(await slugs('кода OR борща OR pdf', 2)).toHaveLength(2);
    expect(await slugs('  ')).toEqual([]);
  });

  it('reindexAll rebuilds the index from the catalog', async () => {
    await pg.sql`delete from search.documents`;
    expect(await reindexAll(search)).toBe(3);
    expect((await slugs('ревью кода'))[0]).toBe('code-review');
  });
});

/** Saves through the repository, as a row written before the reservation would look. */
async function insertLegacyNew(): Promise<void> {
  const slug = Slug.parse('new');
  const input = buildVersionInput(
    [
      {
        path: 'SKILL.md',
        bytes: enc('---\nname: new\ndescription: Legacy onboarding notes\n---\nHi\n'),
      },
    ],
    shaHasher,
  );
  if (!slug.ok || !input.ok) throw new Error('fixture');
  const skill = Skill.create({
    id: randomUUID(),
    slug: slug.value,
    folderId: GENERAL_FOLDER_ID,
    skillMd: input.value.skillMd,
    manifest: input.value.manifest,
    authorId: ACTOR,
    message: null,
    now: new Date(),
    source: null,
    sourceCommit: null,
  });
  if (!skill.ok) throw skill.error;
  await catalog.skills.save(skill.value, input.value.blobs);
}

describe('a skill stored as "new" before the slug was reserved', () => {
  it('can be loaded, indexed and archived; creating another "new" is still refused', async () => {
    await insertLegacyNew();

    const view = await getSkill(catalog, { slug: 'new' });
    expect(view.ok && view.value).toMatchObject({ slug: 'new', status: 'active', version: 1 });

    await indexSkill(search, { slug: 'new' });
    expect(await slugs('legacy onboarding notes')).toContain('new');

    const archived = await archiveSkill(catalog, { slug: 'new', actorId: ACTOR });
    expect(archived.ok).toBe(true);
    await indexSkill(search, { slug: 'new' });
    expect(await slugs('legacy onboarding notes')).not.toContain('new');
    const after = await getSkill(catalog, { slug: 'new' });
    expect(after.ok && after.value.status).toBe('archived');

    const again = await createSkill(catalog, {
      slug: 'new',
      folder: 'general',
      files: [{ path: 'SKILL.md', bytes: enc('---\nname: new\ndescription: d\n---\n') }],
      actorId: ACTOR,
      message: null,
      source: null,
      sourceCommit: null,
    });
    expect(!again.ok && again.error.code).toBe('invalid_slug');
  });
});

async function addFolder(slug: string): Promise<void> {
  const res = await createFolder(catalog, {
    slug,
    name: slug,
    description: `Folder ${slug}`,
    actorId: ACTOR,
  });
  if (!res.ok) throw res.error;
}

/** Delivers every pending outbox event to the Search handlers, in order. */
async function drainOutbox(): Promise<void> {
  const handlers = searchEventHandlers(search);
  const rows = await pg.sql<{ id: string; type: string; payload: Record<string, unknown> }[]>`
    select id, type, payload from platform.outbox where processed_at is null order by id`;
  await rows.reduce(async (prev, row) => {
    await prev;
    await handlers[row.type]?.(row.payload);
    await pg.sql`update platform.outbox set processed_at = now() where id = ${row.id}`;
  }, Promise.resolve());
}

const folderOf = async (slug: string) =>
  (await pg.sql<{ folder: string }[]>`select folder from search.documents where slug = ${slug}`)[0]
    ?.folder;

const QUERY = 'invoice parser';

describe('folder filter (Postgres)', () => {
  beforeEach(async () => {
    await addFolder('decoys');
    await addFolder('target');
    // 60 decoys rank above the target by text and by vector: a folder filter applied after
    // the top-50 candidates would leave nothing from `target`.
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        addSkill(
          `decoy-${String(i).padStart(2, '0')}`,
          'Invoice parser. Invoice parser for invoice files',
          undefined,
          'decoys',
        ),
      ),
    );
    await addSkill('receipts', 'Parser for scanned invoice receipts', undefined, 'target');
  });

  it('without the filter the target is crowded out of both candidate lists', async () => {
    expect(await slugs(QUERY, 100)).not.toContain('receipts');
    embedder.failing = true;
    expect(await slugs(QUERY, 100)).not.toContain('receipts');
  });

  it('finds the target with the filter, by text and by vector', async () => {
    const hits = await searchSkills(search, { query: QUERY, limit: 10, folders: ['target'] });
    expect(hits).toEqual([
      {
        slug: 'receipts',
        name: 'receipts',
        description: 'Parser for scanned invoice receipts',
        folder: 'target',
        score: 1,
      },
    ]);
    embedder.failing = true;
    const ftsOnly = await searchSkills(search, { query: QUERY, limit: 10, folders: ['target'] });
    expect(ftsOnly.map((h) => [h.slug, h.score])).toEqual([['receipts', 0.5]]);
    expect(await searchSkills(search, { query: QUERY, limit: 10, folders: [] })).toEqual([]);
  });

  it('serves the filtered vector query from HNSW with iterative scan', async () => {
    const [ext] = await pg.sql<{ v: string }[]>`
      select extversion as v from pg_extension where extname = 'vector'`;
    const [major = 0, minor = 0] = (ext?.v ?? '0').split('.').map(Number);
    expect(major > 0 || minor >= 8).toBe(true);

    // Seq scans and sorts off, so the planner prefers the HNSW index scan (ordered output, no
    // inner Sort) over the selective folder index, which would win here and need a Sort.
    const conn = postgres(pg.url, {
      max: 1,
      onnotice: () => undefined,
      connection: { enable_seqscan: 'off', enable_sort: 'off' },
    });
    try {
      const scans = async () => {
        const [row] = await conn<{ n: string }[]>`
          select idx_scan as n from pg_stat_user_indexes
          where schemaname = 'search' and indexrelname = 'documents_embedding_idx'`;
        return Number(row?.n ?? 0);
      };
      await conn`select pg_stat_force_next_flush()`;
      const before = await scans();
      const index = new PgSearchIndex(conn);
      const q = await embedder.embedQuery(QUERY);
      expect(await index.vectorCandidates(q, 50, 0.3, ['target'])).toEqual(['receipts']);
      await conn`select pg_stat_force_next_flush()`;
      expect(await scans()).toBeGreaterThan(before);
    } finally {
      await conn.end();
    }
  });

  it('moving a skill updates its document folder via skill_moved', async () => {
    await drainOutbox();
    expect(await folderOf('receipts')).toBe('target');
    const moved = await moveSkill(catalog, { slug: 'receipts', folder: 'decoys', actorId: ACTOR });
    if (!moved.ok) throw moved.error;
    const events = await pg.sql<{ type: string }[]>`
      select type from platform.outbox where processed_at is null`;
    expect(events.map((e) => e.type)).toEqual(['catalog.skill_moved']);
    await drainOutbox();
    expect(await folderOf('receipts')).toBe('decoys');
    expect(
      (await searchSkills(search, { query: QUERY, limit: 100, folders: ['target'] })).length,
    ).toBe(0);
  });

  it('archiving a folder removes its documents once the outbox is delivered', async () => {
    await drainOutbox();
    const res = await archiveFolder(catalog, { slug: 'decoys', actorId: ACTOR });
    if (!res.ok) throw res.error;
    expect(res.value.archivedSkills).toBe(60);
    await drainOutbox();
    const [left] = await pg.sql<{ n: string }[]>`
      select count(*) as n from search.documents where folder = 'decoys'`;
    expect(Number(left?.n)).toBe(0);
    expect(await slugs(QUERY, 100)).toEqual(['receipts']);
    expect(await searchSkills(search, { query: QUERY, limit: 10, folders: ['decoys'] })).toEqual(
      [],
    );
  });
});
