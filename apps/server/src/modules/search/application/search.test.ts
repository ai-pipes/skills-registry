import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { FakeEmbedder } from '../../../../test/fakes/fake-embedder.ts';
import { searchEventHandlers } from './event-handlers.ts';
import { indexMissingEmbeddings } from './index-missing-embeddings.ts';
import { indexSkill } from './index-skill.ts';
import { indexSubagent } from './index-subagent.ts';
import type {
  DocumentKind,
  DocumentSummary,
  IndexedDocument,
  SearchDeps,
  SearchIndex,
  SkillReader,
  SkillSource,
  SubagentReader,
  SubagentSource,
} from './ports.ts';
import { reindexAll } from './reindex-all.ts';
import { searchSkills, searchSubagents } from './search-skills.ts';

const key = (kind: DocumentKind, slug: string) => `${kind}:${slug}`;

/** Documents keyed by `kind:slug`. */
class MemoryIndex implements SearchIndex {
  readonly docs = new Map<string, IndexedDocument>();
  /** The `folders` argument of every candidate query, in call order. */
  readonly folderArgs: { fts: (string[] | null)[]; vector: (string[] | null)[] } = {
    fts: [],
    vector: [],
  };
  private matches(d: IndexedDocument, kind: DocumentKind, folders: string[] | null): boolean {
    return d.kind === kind && (folders === null || folders.includes(d.folder));
  }

  async upsert(doc: IndexedDocument): Promise<void> {
    this.docs.set(key(doc.kind, doc.slug), doc);
    if (doc.embedding) this.failed.delete(key(doc.kind, doc.slug));
  }
  async remove(kind: DocumentKind, slug: string): Promise<void> {
    this.docs.delete(key(kind, slug));
  }
  async slugs(kind: DocumentKind): Promise<string[]> {
    return [...this.docs.values()].filter((d) => d.kind === kind).map((d) => d.slug);
  }
  async slugsWithoutEmbedding(limit: number): Promise<{ kind: DocumentKind; slug: string }[]> {
    return [...this.docs.values()]
      .filter((d) => d.embedding === null && !this.failed.has(key(d.kind, d.slug)))
      .map((d) => ({ kind: d.kind, slug: d.slug }))
      .toSorted((a, b) => key(a.kind, a.slug).localeCompare(key(b.kind, b.slug)))
      .slice(0, limit);
  }
  /** `kind:slug` of documents marked as failed. */
  readonly failed = new Set<string>();
  async markEmbedFailed(kind: DocumentKind, slug: string): Promise<void> {
    this.failed.add(key(kind, slug));
  }
  async ftsCandidates(
    kind: DocumentKind,
    query: string,
    limit: number,
    folders: string[] | null,
  ): Promise<string[]> {
    this.folderArgs.fts.push(folders);
    const words = query.toLowerCase().split(/\s+/);
    return [...this.docs.values()]
      .filter((d) => this.matches(d, kind, folders))
      .filter((d) =>
        words.every((w) => `${d.slug} ${d.name} ${d.description} ${d.body}`.includes(w)),
      )
      .map((d) => d.slug)
      .slice(0, limit);
  }
  async vectorCandidates(
    kind: DocumentKind,
    embedding: number[],
    limit: number,
    minSimilarity: number,
    folders: string[] | null,
  ): Promise<string[]> {
    this.folderArgs.vector.push(folders);
    const dot = (v: number[]) => v.reduce((s, x, i) => s + x * (embedding[i] ?? 0), 0);
    return [...this.docs.values()]
      .filter((d) => this.matches(d, kind, folders))
      .filter((d) => d.embedding !== null && dot(d.embedding) >= minSimilarity)
      .toSorted((a, b) => dot(b.embedding ?? []) - dot(a.embedding ?? []))
      .map((d) => d.slug)
      .slice(0, limit);
  }
  async summaries(kind: DocumentKind, slugs: string[]): Promise<DocumentSummary[]> {
    return slugs.flatMap((s) => {
      const d = this.docs.get(key(kind, s));
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

class MemorySubagentReader implements SubagentReader {
  readonly subagents = new Map<string, SubagentSource>();
  async get(slug: string): Promise<SubagentSource | null> {
    return this.subagents.get(slug) ?? null;
  }
  async listSlugs(): Promise<string[]> {
    return [...this.subagents.keys()];
  }
  put(slug: string, description: string, extra: Partial<SubagentSource> = {}): void {
    this.subagents.set(slug, {
      slug,
      name: slug,
      description,
      body: `prompt of ${slug}`,
      status: 'active',
      version: 1,
      folder: 'general',
      ...extra,
    });
  }
}

let index: MemoryIndex;
let reader: MemoryReader;
let agents: MemorySubagentReader;
let embedder: FakeEmbedder;
let deps: SearchDeps;

beforeEach(() => {
  index = new MemoryIndex();
  reader = new MemoryReader();
  agents = new MemorySubagentReader();
  embedder = new FakeEmbedder();
  deps = { index, skills: reader, subagents: agents, embedder, minSimilarity: 0.5 };
});

describe('indexSkill', () => {
  it('indexes an active skill with body and embedding', async () => {
    reader.put('pdf', 'extract text from pdf', { version: 3 });
    await indexSkill(deps, { slug: 'pdf' });
    const doc = index.docs.get('skill:pdf');
    expect(doc).toMatchObject({ slug: 'pdf', version: 3, body: 'body of pdf' });
    expect(doc?.embedding).toHaveLength(384);
  });

  it('writes the folder from the skill reader', async () => {
    reader.put('pdf', 'x', { folder: 'docs' });
    await indexSkill(deps, { slug: 'pdf' });
    expect(index.docs.get('skill:pdf')?.folder).toBe('docs');
  });

  it('removes archived and missing skills', async () => {
    reader.put('pdf', 'x');
    await indexSkill(deps, { slug: 'pdf' });
    reader.put('pdf', 'x', { status: 'archived' });
    await indexSkill(deps, { slug: 'pdf' });
    expect(index.docs.has('skill:pdf')).toBe(false);

    await index.upsert({ ...indexed('ghost'), embedding: null });
    await indexSkill(deps, { slug: 'ghost' });
    expect(index.docs.has('skill:ghost')).toBe(false);
  });

  it('writes the FTS row without embedding and rethrows when the embedder fails', async () => {
    reader.put('pdf', 'x');
    embedder.failing = true;
    await expect(indexSkill(deps, { slug: 'pdf' })).rejects.toThrow('embedder unavailable');
    expect(index.docs.get('skill:pdf')?.embedding).toBeNull();
  });
});

describe('indexSubagent', () => {
  it('indexes an active subagent with its prompt body, folder and embedding', async () => {
    agents.put('reviewer', 'reviews diffs', { version: 2, folder: 'dev' });
    await indexSubagent(deps, { slug: 'reviewer' });
    const doc = index.docs.get('subagent:reviewer');
    expect(doc).toMatchObject({
      kind: 'subagent',
      slug: 'reviewer',
      version: 2,
      body: 'prompt of reviewer',
      folder: 'dev',
    });
    expect(doc?.embedding).toHaveLength(384);
  });

  it('removes archived and missing subagents', async () => {
    agents.put('reviewer', 'x');
    await indexSubagent(deps, { slug: 'reviewer' });
    agents.put('reviewer', 'x', { status: 'archived' });
    await indexSubagent(deps, { slug: 'reviewer' });
    expect(index.docs.has('subagent:reviewer')).toBe(false);

    await index.upsert(indexed('ghost', 'subagent'));
    await indexSubagent(deps, { slug: 'ghost' });
    expect(index.docs.has('subagent:ghost')).toBe(false);
  });

  it('writes the FTS row without embedding and rethrows when the embedder fails', async () => {
    agents.put('reviewer', 'x');
    embedder.failing = true;
    await expect(indexSubagent(deps, { slug: 'reviewer' })).rejects.toThrow('embedder unavailable');
    expect(index.docs.get('subagent:reviewer')?.embedding).toBeNull();
  });

  it('keeps a skill and a subagent with the same slug apart', async () => {
    reader.put('devops', 'deploy skill');
    agents.put('devops', 'deploy agent');
    await indexSkill(deps, { slug: 'devops' });
    await indexSubagent(deps, { slug: 'devops' });
    expect([...index.docs.keys()].toSorted()).toEqual(['skill:devops', 'subagent:devops']);

    agents.put('devops', 'deploy agent', { status: 'archived' });
    await indexSubagent(deps, { slug: 'devops' });
    expect([...index.docs.keys()]).toEqual(['skill:devops']);

    agents.put('devops', 'deploy agent');
    await indexSubagent(deps, { slug: 'devops' });
    reader.put('devops', 'deploy skill', { status: 'archived' });
    await indexSkill(deps, { slug: 'devops' });
    expect([...index.docs.keys()]).toEqual(['subagent:devops']);
  });
});

const indexed = (slug: string, kind: DocumentKind = 'skill'): IndexedDocument => ({
  kind,
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

describe('searchSubagents', () => {
  beforeEach(async () => {
    reader.put('deploy', 'deploy to production');
    agents.put('deployer', 'deploy to production');
    agents.put('reviewer', 'code review before merge', { folder: 'dev' });
    await reindexAll(deps);
  });

  it('returns subagents only, scored like skills', async () => {
    expect(await searchSubagents(deps, { query: 'deploy', limit: 10 })).toEqual([
      {
        slug: 'deployer',
        name: 'deployer',
        description: 'deploy to production',
        folder: 'general',
        score: 0.5,
      },
    ]);
    expect((await searchSkills(deps, { query: 'deploy', limit: 10 })).map((h) => h.slug)).toEqual([
      'deploy',
    ]);
  });

  it('restricts the search to folders', async () => {
    expect(
      (await searchSubagents(deps, { query: 'merge', limit: 10, folders: ['dev'] })).map(
        (h) => h.slug,
      ),
    ).toEqual(['reviewer']);
    expect(
      await searchSubagents(deps, { query: 'merge', limit: 10, folders: ['general'] }),
    ).toEqual([]);
    expect(await searchSubagents(deps, { query: 'merge', limit: 10, folders: [] })).toEqual([]);
  });

  it('searchSkills never returns a subagent, even the best match of both lists', async () => {
    // 60 subagents match the query better than the one skill, by text and by vector: a kind
    // filter applied after the top-50 candidates would leave no skill at all.
    for (let i = 0; i < 60; i += 1) agents.put(`agent-${i}`, 'invoice parser');
    reader.put('receipts', 'invoice parser for scanned paper receipts and bills');
    await reindexAll(deps);
    // τ low enough for the skill and every subagent to clear it.
    const low = { ...deps, minSimilarity: 0.2 };
    const skills = await searchSkills(low, { query: 'invoice parser', limit: 100 });
    expect(skills.map((h) => [h.slug, h.score])).toEqual([['receipts', 1]]);
    const subagents = await searchSubagents(low, { query: 'invoice parser', limit: 100 });
    expect(subagents.length).toBeGreaterThan(0);
    expect(subagents.every((h) => h.slug.startsWith('agent-'))).toBe(true);
  });
});

describe('reindexAll', () => {
  it('indexes every skill, drops stale documents and returns the active count', async () => {
    reader.put('a', 'x');
    reader.put('b', 'y', { status: 'archived' });
    await index.upsert(indexed('stale'));
    expect(await reindexAll(deps)).toBe(1);
    expect([...index.docs.keys()]).toEqual(['skill:a']);
  });

  it('writes every FTS row before rethrowing an embedder failure', async () => {
    reader.put('a', 'x');
    reader.put('b', 'y');
    embedder.failing = true;
    await expect(reindexAll(deps)).rejects.toThrow('embedder unavailable');
    expect([...index.docs.keys()].toSorted()).toEqual(['skill:a', 'skill:b']);
  });

  it('covers both kinds: drops stale documents of each, returns the total', async () => {
    reader.put('devops', 'x');
    agents.put('devops', 'y');
    agents.put('old', 'z', { status: 'archived' });
    await index.upsert(indexed('gone-skill'));
    await index.upsert(indexed('gone-agent', 'subagent'));
    // Same slug, other kind: the subagent "only-skill" is stale, the skill of that slug is not.
    reader.put('only-skill', 'w');
    await index.upsert(indexed('only-skill', 'subagent'));
    expect(await reindexAll(deps)).toBe(3);
    expect([...index.docs.keys()].toSorted()).toEqual([
      'skill:devops',
      'skill:only-skill',
      'subagent:devops',
    ]);
  });
});

describe('searchEventHandlers', () => {
  it('reindexes the slug from catalog events', async () => {
    const handlers = searchEventHandlers(deps);
    expect(
      Object.keys(handlers)
        .filter((t) => t.includes('skill_'))
        .toSorted(),
    ).toEqual([
      'catalog.skill_archived',
      'catalog.skill_moved',
      'catalog.skill_restored',
      'catalog.skill_version_created',
    ]);
    reader.put('pdf', 'x');
    await handlers['catalog.skill_version_created']?.({ skillId: 'id', slug: 'pdf', version: 1 });
    expect(index.docs.has('skill:pdf')).toBe(true);
    reader.put('pdf', 'x', { status: 'archived' });
    await handlers['catalog.skill_archived']?.({ skillId: 'id', slug: 'pdf' });
    expect(index.docs.has('skill:pdf')).toBe(false);
  });

  it('updates the document folder on skill_moved', async () => {
    const handlers = searchEventHandlers(deps);
    reader.put('pdf', 'x');
    await indexSkill(deps, { slug: 'pdf' });
    reader.put('pdf', 'x', { folder: 'docs' });
    await handlers['catalog.skill_moved']?.({ skillId: 'id', slug: 'pdf', folder: 'docs' });
    expect(index.docs.get('skill:pdf')?.folder).toBe('docs');
  });

  it('re-syncs the subagent document from subagent events, leaving the skill alone', async () => {
    const handlers = searchEventHandlers(deps);
    expect(
      Object.keys(handlers)
        .filter((t) => t.includes('subagent'))
        .toSorted(),
    ).toEqual([
      'catalog.subagent_archived',
      'catalog.subagent_moved',
      'catalog.subagent_restored',
      'catalog.subagent_version_created',
    ]);
    reader.put('devops', 'x');
    await indexSkill(deps, { slug: 'devops' });
    agents.put('devops', 'y');
    await handlers['catalog.subagent_version_created']?.({
      subagentId: 'id',
      slug: 'devops',
      version: 1,
    });
    expect(index.docs.get('subagent:devops')?.folder).toBe('general');
    agents.put('devops', 'y', { folder: 'ops' });
    await handlers['catalog.subagent_moved']?.({ subagentId: 'id', slug: 'devops', folder: 'ops' });
    expect(index.docs.get('subagent:devops')?.folder).toBe('ops');
    agents.put('devops', 'y', { status: 'archived', folder: 'ops' });
    await handlers['catalog.subagent_archived']?.({ subagentId: 'id', slug: 'devops' });
    expect([...index.docs.keys()]).toEqual(['skill:devops']);
    agents.put('devops', 'y', { folder: 'ops' });
    await handlers['catalog.subagent_restored']?.({ subagentId: 'id', slug: 'devops' });
    expect([...index.docs.keys()].toSorted()).toEqual(['skill:devops', 'subagent:devops']);
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
    expect((await indexMissingEmbeddings(deps, { limit: 2 })).indexed).toEqual([
      'skill:a',
      'skill:b',
    ]);
    expect(missing()).toBe(1);
    expect((await indexMissingEmbeddings(deps, { limit: 2 })).indexed).toEqual(['skill:c']);
    expect(missing()).toBe(0);
    expect(await indexMissingEmbeddings(deps, { limit: 2 })).toEqual({
      indexed: [],
      failed: [],
      stoppedEarly: null,
    });
  });

  it('fills in a subagent document and marks a poison one by kind', async () => {
    agents.put('a', 'agent a');
    agents.put('z', 'agent z');
    embedder.failing = true;
    await reindexAll(deps).catch(() => undefined);
    embedder.failing = false;
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      if (texts.some((t) => t.includes('agent a'))) throw new Error('poison');
      return real(texts);
    };
    expect(await indexMissingEmbeddings(deps, { limit: 20 })).toEqual({
      indexed: ['skill:a', 'skill:b', 'skill:c', 'subagent:z'],
      failed: ['subagent:a'],
      stoppedEarly: null,
    });
    expect([...index.failed]).toEqual(['subagent:a']);
    expect(index.docs.get('subagent:z')?.embedding).toHaveLength(384);
    expect(index.docs.get('skill:a')?.embedding).toHaveLength(384);
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
      indexed: ['skill:b', 'skill:c'],
      failed: ['skill:a'],
      stoppedEarly: null,
    });
    expect([...index.failed]).toEqual(['skill:a']);
    const before = embedder.calls;
    expect((await indexMissingEmbeddings(deps, { limit: 20 })).indexed).toEqual([]);
    expect(embedder.calls).toBe(before);
  });

  it('treats 3 consecutive failures as an outage: stops, marks nothing', async () => {
    embedder.failing = true;
    const before = embedder.calls;
    expect(await indexMissingEmbeddings(deps, { limit: 20 })).toEqual({
      indexed: [],
      failed: ['skill:a', 'skill:b', 'skill:c'],
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
      indexed: ['skill:b-ok'],
      failed: ['skill:a-p1', 'skill:a-p2', 'skill:a-p3'],
      stoppedEarly: null,
    });
    expect([...index.failed].toSorted()).toEqual(['skill:a-p1', 'skill:a-p2', 'skill:a-p3']);
    expect(index.docs.get('skill:b-ok')?.embedding).not.toBeNull();
  });

  it('stops at the wall-clock budget without marking anything', async () => {
    let t = 0;
    const real = embedder.embedPassages.bind(embedder);
    embedder.embedPassages = async (texts) => {
      t += 20_000;
      return real(texts);
    };
    const r = await indexMissingEmbeddings(deps, { limit: 20, budgetMs: 30_000, now: () => t });
    expect(r).toEqual({ indexed: ['skill:a', 'skill:b'], failed: [], stoppedEarly: 'budget' });
    expect(missing()).toBe(1);
    expect(index.failed.size).toBe(0);
  });
});
