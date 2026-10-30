import type { Embedder } from '../../src/modules/search/application/ports.ts';

const DIMENSIONS = 384;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Deterministic bag-of-tokens vector: each token hashes into one of 384 buckets, L2-normalized. */
function fakeVector(text: string): number[] {
  const v = Array.from({ length: DIMENSIONS }, () => 0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const i = fnv1a(token) % DIMENSIONS;
    v[i] = (v[i] ?? 0) + 1;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v.map((_, i) => (i === 0 ? 1 : 0)) : v.map((x) => x / norm);
}

export class FakeEmbedder implements Embedder {
  readonly dimensions = 384 as const;
  /** While true, every embedding call rejects (a broken or missing model). */
  failing: boolean;
  calls = 0;

  constructor(opts: { failing?: boolean } = {}) {
    this.failing = opts.failing ?? false;
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.failing) throw new Error('embedder unavailable');
    return texts.map(fakeVector);
  }

  async embedQuery(text: string): Promise<number[]> {
    this.calls += 1;
    if (this.failing) throw new Error('embedder unavailable');
    return fakeVector(text);
  }
}
