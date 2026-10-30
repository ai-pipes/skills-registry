import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPgCatalog, createSkill } from '../../src/modules/catalog/index.ts';
import {
  createCatalogSkillReader,
  createPgSearch,
  DEFAULT_MIN_SIMILARITY,
  indexSkill,
  type SearchDeps,
  searchSkills,
  TransformersEmbedder,
} from '../../src/modules/search/index.ts';
import { PgAuditLog } from '../../src/platform/audit.ts';
import { FixedClock } from '../fakes/fixed-clock.ts';
import { shaHasher } from '../fakes/sha-hasher.ts';
import { startPg } from '../pg.ts';

// Gated like embedder.int.test.ts: needs the real model in $MODEL_DIR or ALLOW_MODEL_DOWNLOAD=1.
const MODEL = 'Xenova/multilingual-e5-small';
const modelDir = process.env['MODEL_DIR'];
const hasLocalModel =
  modelDir !== undefined && existsSync(join(modelDir, MODEL, 'onnx', 'model_quantized.onnx'));
const enabled = hasLocalModel || process.env['ALLOW_MODEL_DOWNLOAD'] === '1';
const SKIP_REASON = enabled
  ? ''
  : ` [skipped: no model at $MODEL_DIR/${MODEL} and ALLOW_MODEL_DOWNLOAD is not 1]`;

// English skills, Russian queries: the real multilingual model must match across languages
// ("ревью кода" = "code review", "заполнить PDF-форму" = "fill in a PDF form") and keep an
// unrelated query ("рецепт борща" = "borscht recipe") below the similarity floor.
const SKILLS = {
  'code-review': [
    'Review pull requests and code changes for bugs, readability and missing tests.',
    '# Code review\n\nRead the diff, then check correctness first, tests second and style last.',
  ],
  pdf: [
    'Fill in PDF forms and extract the values of their fields.',
    '# PDF forms\n\nUse a PDF library to list the form fields, then fill them in or read them out.',
  ],
} as const;

describe.skipIf(!enabled)(`search relevance floor on the real model${SKIP_REASON}`, () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let search: SearchDeps;

  beforeAll(async () => {
    pg = await startPg();
    const catalog = {
      ...createPgCatalog(pg.sql),
      hasher: shaHasher,
      ids: { uuid: () => randomUUID() },
      clock: new FixedClock(),
      audit: new PgAuditLog(pg.sql),
    };
    search = {
      ...createPgSearch(pg.sql),
      embedder: new TransformersEmbedder({
        modelDir: modelDir ?? join(tmpdir(), 'skills-registry-models'),
        allowRemote: !hasLocalModel,
      }),
      skills: createCatalogSkillReader(catalog),
      minSimilarity: DEFAULT_MIN_SIMILARITY,
    };
    await Promise.all(
      Object.entries(SKILLS).map(async ([slug, [description, body]]) => {
        const md = `---\nname: ${slug}\ndescription: ${description}\n---\n${body}\n`;
        const res = await createSkill(catalog, {
          slug,
          folder: 'general',
          files: [{ path: 'SKILL.md', bytes: new TextEncoder().encode(md) }],
          actorId: randomUUID(),
          message: null,
          source: null,
          sourceCommit: null,
        });
        if (!res.ok) throw res.error;
        // Embedding the passage loads the model, so ready() is true afterwards.
        await indexSkill(search, { slug });
      }),
    );
    expect(await search.embedder.ready()).toBe(true);
  }, 300_000);
  afterAll(async () => {
    await pg?.stop();
  });

  const slugs = async (query: string) =>
    (await searchSkills(search, { query, limit: 10 })).map((h) => h.slug);

  it('finds nothing for an unrelated query', async () => {
    expect(await slugs('рецепт борща')).toEqual([]);
  });

  it('finds code-review for «ревью кода»', async () => {
    expect(await slugs('ревью кода')).toEqual(['code-review']);
  });

  it('ranks pdf first for «заполнить PDF-форму»', async () => {
    expect((await slugs('заполнить PDF-форму'))[0]).toBe('pdf');
  });
});
