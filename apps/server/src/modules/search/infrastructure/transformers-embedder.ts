import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import type { Embedder } from '../application/ports.ts';

const MODEL = 'Xenova/multilingual-e5-small';
const DIMENSIONS = 384;

const isMatrix = (v: unknown, rows: number): v is number[][] =>
  Array.isArray(v) &&
  v.length === rows &&
  v.every(
    (row) =>
      Array.isArray(row) && row.length === DIMENSIONS && row.every((x) => typeof x === 'number'),
  );

/**
 * Local multilingual-e5-small (q8) via transformers.js. The model is loaded lazily on first
 * use; `ready()` kicks off loading in the background and reports whether it has finished.
 * With `allowRemote: false` the model is read only from `modelDir/Xenova/multilingual-e5-small`.
 */
export class TransformersEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  private loading: Promise<FeatureExtractionPipeline> | null = null;
  private loaded: FeatureExtractionPipeline | null = null;

  constructor(private readonly opts: { modelDir: string; allowRemote: boolean }) {}

  async ready(): Promise<boolean> {
    if (this.loaded) return true;
    this.load().catch(() => undefined);
    return false;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embed(texts.map((t) => `passage: ${t}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`query: ${text}`]);
    if (!vector) throw new Error('embedder returned no vector');
    return vector;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.load();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const vectors: unknown = output.tolist();
    if (!isMatrix(vectors, texts.length)) {
      throw new Error(`expected ${texts.length} embeddings of ${DIMENSIONS} numbers`);
    }
    return vectors;
  }

  private load(): Promise<FeatureExtractionPipeline> {
    this.loading ??= this.createPipeline().then(
      (extractor) => {
        this.loaded = extractor;
        return extractor;
      },
      (error: unknown) => {
        // Allow a later call to retry (e.g. the model directory was populated afterwards).
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  private async createPipeline(): Promise<FeatureExtractionPipeline> {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.localModelPath = this.opts.modelDir;
    env.cacheDir = this.opts.modelDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = this.opts.allowRemote;
    return pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  }
}
