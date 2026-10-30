import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { FakeEmbedder } from '../../../../test/fakes/fake-embedder.ts';
import { searchEventHandlers } from './event-handlers.ts';
import { indexMissingEmbeddings } from './index-missing-embeddings.ts';
import { indexSkill } from './index-skill.ts';
import type {
  DocumentSummary,
  IndexedDocument,
  SearchDeps,
  SearchIndex,
  SkillReader,
  SkillSource,
} from './ports.ts';
import { reindexAll } from './reindex-all.ts';
import { searchSkills } from './search-skills.ts';

class MemoryIndex implements SearchIndex {
  readonly docs = new Map<string, IndexedDocument>();
  /** The `folders` argument of every candidate query, in call order. */
  readonly folderArgs: { fts: (string[] | null)[]; vector: (string[] | null)[] } = {
    fts: [],
    vector: [],
  };
  private inFolders(d: IndexedDocument, folders: string[] | null): boolean {
    return folders === null || folders.includes(d.folder);
  }

  async upsert(doc: IndexedDocument): Promise<void> {
    this.docs.set(doc.slug, doc);
    if (doc.embedding) this.failed.delete(doc.slug);
  }
  async remove(slug: string): Promise<void> {
    this.docs.delete(slug);
  }
  async slugs(): Promise<string[]> {
    return [...this.docs.keys()];
  }
  async slugsWithoutEmbedding(limit: number): Promise<string[]> {
    return [...this.docs.values()]
      .filter((d) => d.embedding === null && !this.failed.has(d.slug))
      .map((d) => d.slug)
      .toSorted()
      .slice(0, limit);
  }
  readonly failed = new Set<string>();
  async markEmbedFailed(slug: string): Promise<void> {
    this.failed.add(slug);
  }
  async ftsCandidates(query: string, limit: number, folders: string[] | null): Promise<string[]> {
    this.folderArgs.fts.push(folders);
    const words = query.toLowerCase().split(/\s+/);
    return [...this.docs.values()]
      .filter((d) => this.inFolders(d, folders))
      .filter((d) =>
        words.every((w) => `${d.slug} ${d.name} ${d.description} ${d.body}`.includes(w)),
      )
      .map((d) => d.slug)
      .slice(0, limit);
  }
  async vectorCandidates(
    embedding: number[],
    limit: number,
    minSimilarity: number,
    folders: string[] | null,
  ): Promise<string[]> {
    this.folderArgs.vector.push(folders);
    const dot = (v: number[]) => v.reduce((s, x, i) => s + x * (embedding[i] ?? 0), 0);
    return [...this.docs.values()]
      .filter((d) => this.inFolders(d, folders))
      .filter((d) => d.embedding !== null && dot(d.embedding) >= minSimilarity)
      .toSorted((a, b) => dot(b.embedding ?? []) - dot(a.embedding ?? []))
      .map((d) => d.slug)
      .slice(0, limit);
  }
  async summaries(slugs: string[]): Promise<DocumentSummary[]> {
    return slugs.flatMap((s) => {
      const d = this.docs.get(s);
      return d
        ? [{ slug: d.slug, name: d.name, description: d.description, folder: d.folder }]
        : [];
    });
  }
}

class MemoryReader implements SkillReader {
  readonly skills = new Map<string, SkillSource>();
  async get(slug: string): Promise<SkillSource | null> {
    return this.skills.get(slug) ?? null;
  }
  async listSlugs(): Promise<string[]> {
    return [...this.skills.keys()];
  }
  put(slug: string, description: string, extra: Partial<SkillSource> = {}): void {
    this.skills.set(slug, {
      slug,
      name: slug,
      description,
      skillMd: `---\nname: ${slug}\ndescription: ${description}\n---\nbody of ${slug}\n`,
      status: 'active',
      version: 1,
      folder: 'general',
      ...extra,
    });
  }
}

let index: MemoryIndex;
let reader: MemoryReader;
let embedder: FakeEmbedder;
let deps: SearchDeps;

beforeEach(() => {
  index = new MemoryIndex();
  reader = new MemoryReader();
  embedder = new FakeEmbedder();
  deps = { index, skills: reader, embedder, minSimilarity: 0.5 };
});

describe('indexSkill', () => {
  it('indexes an active skill with body and embedding', async () => {
    reader.put('pdf', 'extract text from pdf', { version: 3 });
    await indexSkill(deps, { slug: 'pdf' });
    const doc = index.docs.get('pdf');
    expect(doc).toMatchObject({ slug: 'pdf', version: 3, body: 'body of pdf' });
    expect(doc?.embedding).toHaveLength(384);
  });

  it('writes the folder from the skill reader', async () => {
    reader.put('pdf', 'x', { folder: 'docs' });
    await indexSkill(deps, { slug: 'pdf' });
    expect(index.docs.get('pdf')?.folder).toBe('docs');
  });

  it('removes archived and missing skills', async () => {
    reader.put('pdf', 'x');
    await indexSkill(deps, { slug: 'pdf' });
    reader.put('pdf', 'x', { status: 'archived' });
    await indexSkill(deps, { slug: 'pdf' });
    expect(index.docs.has('pdf')).toBe(false);

    await index.upsert({ ...indexed('ghost'), embedding: null });
    await indexSkill(deps, { slug: 'ghost' });
    expect(index.docs.has('ghost')).toBe(false);
  });

  it('writes the FTS row without embedding and rethrows when the embedder fails', async () => {
    reader.put('pdf', 'x');
    embedder.failing = true;
    await expect(indexSkill(deps, { slug: 'pdf' })).rejects.toThrow('embedder unavailable');
    expect(index.docs.get('pdf')?.embedding).toBeNull();
  });
});

const indexed = (slug: string): IndexedDocument => ({
  slug,
  name: slug,
  description: '',
  version: 1,
  body: '',
  folder: 'general',
  embedding: null,
});

describe('searchSkills', () => {
  beforeEach(async () => {
    reader.put('pdf', 'extract text from pdf');
    reader.put('review', 'code review before merge');
    reader.put('borscht', 'cooking recipe');
    await reindexAll(deps);
  });

  it('returns [] for a blank query without touching the embedder', async () => {
    const before = embedder.calls;
    expect(await searchSkills(deps, { query: '   ', limit: 10 })).toEqual([]);
    expect(embedder.calls).toBe(before);
  });

  it('returns [] when nothing matches the text and no vector clears the floor', async () => {
    expect(await searchSkills(deps, { query: 'weather tomorrow', limit: 10 })).toEqual([]);
  });

  it('scores a hit by the share of the best possible fused score', async () => {
    // "merge" matches review by text only; its vector similarity is below the floor, so the
    // hit is rank 1 in one of the two lists consulted: score 0.5, not 1.
    expect(await searchSkills(deps, { query: 'merge', limit: 10 })).toEqual([
      {
        slug: 'review',
        name: 'review',
        description: 'code review before merge',
        folder: 'general',
        score: 0.5,
      },
    ]);
  });

  it('gives the same FTS-only hit the same score whether or not the embedder is ready', async () => {
    const ready = await searchSkills(deps, { query: 'merge', limit: 10 });
    embedder.ready = async () => false;
    const notReady = await searchSkills(deps, { query: 'merge', limit: 10 });
    expect(notReady).toEqual(ready);
    expect(notReady[0]?.score).toBe(0.5);
  });

  it('fuses FTS and vector candidates; first in both lists scores 1', async () => {
    const res = await searchSkills(deps, { query: 'pdf', limit: 10 });
    expect(res[0]).toEqual({
      slug: 'pdf',
      name: 'pdf',
      description: 'extract text from pdf',
      folder: 'general',
      score: 1,
    });
    expect(res.every((r) => r.score > 0 && r.score <= 1)).toBe(true);
  });

  it('respects limit', async () => {
    expect(await searchSkills(deps, { query: 'pdf', limit: 1 })).toHaveLength(1);
    expect(await searchSkills(deps, { query: 'pdf', limit: 0 })).toEqual([]);
  });

  it('falls back to FTS-only when the embedder fails or is not ready', async () => {
    embedder.failing = true;
    expect((await searchSkills(deps, { query: 'pdf', limit: 10 })).map((r) => r.slug)).toEqual([
      'pdf',
    ]);
    embedder.failing = false;
    embedder.ready = async () => false;
    const before = embedder.calls;
    expect((await searchSkills(deps, { query: 'merge', limit: 10 })).map((r) => r.slug)).toEqual([
      'review',
    ]);
    expect(embedder.calls).toBe(before);
  });

  it('skips the vector query for text longer than the embedding limit', async () => {
    const before = embedder.calls;
    expect(await searchSkills(deps, { query: 'z'.repeat(2001), limit: 10 })).toEqual([]);
    expect(embedder.calls).toBe(before);
  });

  it('drops candidates whose document vanished between queries', async () => {
    index.summaries = async () => [];
    expect(await searchSkills(deps, { query: 'pdf', limit: 10 })).toEqual([]);
  });

  it('searches every folder when no folders are given', async () => {
    await searchSkills(deps, { query: 'pdf', limit: 10 });
    expect(index.folderArgs).toEqual({ fts: [null], vector: [null] });
  });

  it('filters by folder before candidate selection', async () => {
    // 60 decoys in `a` are more similar to the query than the one skill in `b`: a filter
    // applied after the top-50 candidates would never see the `b` skill.
    for (let i = 0; i < 60; i += 1) {
      reader.put(`decoy-${i}`, 'invoice parser', { folder: 'a' });
    }
    reader.put('target', 'invoice parser for scanned paper receipts and bills', { folder: 'b' });
    await reindexAll(deps);
    index.folderArgs.fts.length = 0;
    index.folderArgs.vector.length = 0;
    // τ low enough for the target (~0.38) and every decoy (~0.41) to clear it.
    const low = { ...deps, minSimilarity: 0.3 };
    const all = await searchSkills(low, { query: 'invoice parser', limit: 60 });
    expect(all.map((r) => r.slug)).not.toContain('target');
    index.folderArgs.fts.length = 0;
    index.folderArgs.vector.length = 0;
    const res = await searchSkills(low, { query: 'invoice parser', limit: 10, folders: ['b'] });
    expect(index.folderArgs).toEqual({ fts: [['b']], vector: [['b']] });
    expect(res.map((r) => [r.slug, r.folder])).toEqual([['target', 'b']]);
    expect(res[0]?.score).toBe(1);
  });

  it('returns [] for an empty folder list without querying', async () => {
    const before = embedder.calls;
    expect(await searchSkills(deps, { query: 'pdf', limit: 10, folders: [] })).toEqual([]);
    expect(index.folderArgs).toEqual({ fts: [], vector: [] });
    expect(embedder.calls).toBe(before);
  });
});

describe('reindexAll', () => {
  it('indexes every skill, drops stale documents and returns the active count', async () => {
    reader.put('a', 'x');
    reader.put('b', 'y', { status: 'archived' });
    await index.upsert(indexed('stale'));
    expect(await reindexAll(deps)).toBe(1);
    expect([...index.docs.keys()]).toEqual(['a']);
  });

  it('writes every FTS row before rethrowing an embedder failure', async () => {
    reader.put('a', 'x');
    reader.put('b', 'y');
    embedder.failing = true;
    await expect(reindexAll(deps)).rejects.toThrow('embedder unavailable');
    expect([...index.docs.keys()].toSorted()).toEqual(['a', 'b']);
  });
});

describe('searchEventHandlers', () => {
  it('reindexes the slug from catalog events', async () => {
    const handlers = searchEventHandlers(deps);
    expect(Object.keys(handlers).toSorted()).toEqual([
      'catalog.skill_archived',
      'catalog.skill_moved',
      'catalog.skill_restored',
      'catalog.skill_version_created',
    ]);
    reader.put('pdf', 'x');
    await handlers['catalog.skill_version_created']?.({ skillId: 'id', slug: 'pdf', version: 1 });
    expect(index.docs.has('pdf')).toBe(true);
    reader.put('pdf', 'x', { status: 'archived' });
    await handlers['catalog.skill_archived']?.({ skillId: 'id', slug: 'pdf' });
    expect(index.docs.has('pdf')).toBe(false);
  });

  it('updates the document folder on skill_moved', async () => {
    const handlers = searchEventHandlers(deps);
    reader.put('pdf', 'x');
    await indexSkill(deps, { slug: 'pdf' });
    reader.put('pdf', 'x', { folder: 'docs' });
    await handlers['catalog.skill_moved']?.({ skillId: 'id', slug: 'pdf', folder: 'docs' });
    expect(index.docs.get('pdf')?.folder).toBe('docs');
  });

  it('rejects a payload without slug', async () => {
    const handler = searchEventHandlers(deps)['catalog.skill_restored'];
    await expect(handler?.({ skillId: 'id' })).rejects.toThrow('slug');
  });
});

const missing = () => [...index.docs.values()].filter((d) => d.embedding === null).length;

describe('indexMissingEmbeddings', () => {
  beforeEach(async () => {
    for (const slug of ['a', 'b', 'c']) reader.put(slug, `skill ${slug}`);
    embedder.failing = true;
    await reindexAll(deps).catch(() => undefined);
    embedder.failing = false;
  });

  it('re-indexes documents without an embedding, at most `limit` per run', async () => {
    expect(missing()).toBe(3);
    expect((await indexMissingEmbeddings(deps, { limit: 2 })).indexed).toEqual(['a', 'b']);
    expect(missing()).toBe(1);
    expect((await indexMissingEmbeddings(deps, { limit: 2 })).indexed).toEqual(['c']);
    expect(missing()).toBe(0);
    expect(await indexMissingEmbeddings(deps, { limit: 2 })).toEqual({
      indexed: [],
      failed: [],
      stoppedEarly: null,
    });
  });

  it('does nothing while the embedder is not ready', async () => {
    embedder.ready = async () => false;
    const before = embedder.calls;
    expect((await indexMissingEmbeddings(deps, { limit: 20 })).indexed).toEqual([]);
    expect(embedder.calls).toBe(before);
    expect(missing()).toBe(3);
  });

  it('marks only an isolated poison document and reports it', async () => {
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      if (texts.some((t) => t.includes('skill a'))) throw new Error('poison');
      return real(texts);
    };
    expect(await indexMissingEmbeddings(deps, { limit: 20 })).toEqual({
      indexed: ['b', 'c'],
      failed: ['a'],
      stoppedEarly: null,
    });
    expect([...index.failed]).toEqual(['a']);
    const before = embedder.calls;
    expect((await indexMissingEmbeddings(deps, { limit: 20 })).indexed).toEqual([]);
    expect(embedder.calls).toBe(before);
  });

  it('treats 3 consecutive failures as an outage: stops, marks nothing', async () => {
    embedder.failing = true;
    const before = embedder.calls;
    expect(await indexMissingEmbeddings(deps, { limit: 20 })).toEqual({
      indexed: [],
      failed: ['a', 'b', 'c'],
      stoppedEarly: 'outage',
    });
    expect(embedder.calls).toBe(before + 4); // 3 documents + 1 probe
    expect(index.failed.size).toBe(0);
  });

  it('marks a poison streak when the probe succeeds and carries on with the rest', async () => {
    for (const slug of ['a-p1', 'a-p2', 'a-p3', 'b-ok']) reader.put(slug, `skill ${slug}`);
    for (const slug of ['a', 'b', 'c']) reader.skills.delete(slug);
    index.docs.clear();
    await reindexAll(deps);
    for (const d of index.docs.values()) d.embedding = null;
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      if (texts.some((t) => t.includes('a-p'))) throw new Error('poison');
      return real(texts);
    };
    expect(await indexMissingEmbeddings(deps, { limit: 20 })).toEqual({
      indexed: ['b-ok'],
      failed: ['a-p1', 'a-p2', 'a-p3'],
      stoppedEarly: null,
    });
    expect([...index.failed].toSorted()).toEqual(['a-p1', 'a-p2', 'a-p3']);
    expect(index.docs.get('b-ok')?.embedding).not.toBeNull();
  });

  it('stops at the wall-clock budget without marking anything', async () => {
    let t = 0;
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      t += 20_000;
      return real(texts);
    };
    const r = await indexMissingEmbeddings(deps, { limit: 20, budgetMs: 30_000, now: () => t });
    expect(r).toEqual({ indexed: ['a', 'b'], failed: [], stoppedEarly: 'budget' });
    expect(missing()).toBe(1);
    expect(index.failed.size).toBe(0);
  });
});
