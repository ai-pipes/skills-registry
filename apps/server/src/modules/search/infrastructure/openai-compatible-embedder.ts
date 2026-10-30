import { z } from 'zod';
import type { Embedder } from '../application/ports.ts';

const DIMENSIONS = 384;
const TIMEOUT_MS = 20_000;

const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().optional(),
      embedding: z.array(z.number()).length(DIMENSIONS),
    }),
  ),
});

/** Embeddings from an OpenAI-compatible `POST {url}/embeddings` endpoint serving a 384-d e5 model. */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;

  constructor(private readonly opts: { url: string; model: string }) {}

  async ready(): Promise<boolean> {
    return true;
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

  private async embed(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.opts.url.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.opts.model, input }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embedder responded with HTTP ${res.status}`);
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.data.length !== input.length) {
      throw new Error(`embedder must return ${input.length} vectors of ${DIMENSIONS} numbers`);
    }
    return parsed.data.data
      .map((d, i) => ({ at: d.index ?? i, embedding: d.embedding }))
      .toSorted((a, b) => a.at - b.at)
      .map((d) => d.embedding);
  }
}
