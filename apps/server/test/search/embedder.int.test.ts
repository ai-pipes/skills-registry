import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { TransformersEmbedder } from '../../src/modules/search/index.ts';

const MODEL = 'Xenova/multilingual-e5-small';
const modelDir = process.env['MODEL_DIR'];
const hasLocalModel =
  modelDir !== undefined && existsSync(join(modelDir, MODEL, 'onnx', 'model_quantized.onnx'));
const allowDownload = process.env['ALLOW_MODEL_DOWNLOAD'] === '1';
const enabled = hasLocalModel || allowDownload;

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

const SKIP_REASON = enabled
  ? ''
  : ` [skipped: no model at $MODEL_DIR/${MODEL} and ALLOW_MODEL_DOWNLOAD is not 1]`;

// Cross-language check of the multilingual model: "ревью кода" means "code review",
// "рецепт борща" means "borscht recipe".
describe('TransformersEmbedder (real model)', () => {
  it.skipIf(!enabled)(
    `ranks "code review" closer to "ревью кода" than "рецепт борща"${SKIP_REASON}`,
    async () => {
      const embedder = new TransformersEmbedder({
        modelDir: modelDir ?? join(tmpdir(), 'skills-registry-models'),
        allowRemote: !hasLocalModel,
      });
      const query = await embedder.embedQuery('ревью кода');
      const [review, borscht] = await embedder.embedPassages(['code review', 'рецепт борща']);
      expect(await embedder.ready()).toBe(true);
      expect(query).toHaveLength(384);
      expect(cosine(query, review!)).toBeGreaterThan(cosine(query, borscht!));
    },
    300_000,
  );
});
