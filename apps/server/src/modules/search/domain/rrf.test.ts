import { describe, expect, it } from 'vite-plus/test';
import { rrf } from './rrf.ts';

describe('rrf', () => {
  it('fuses two ranked lists', () => {
    expect(
      rrf(
        [
          ['a', 'b', 'c'],
          ['c', 'a'],
        ],
        60,
      ).map((r) => r.id),
    ).toEqual(['a', 'c', 'b']);
  });

  it('sums 1 / (k + rank) with 1-based ranks', () => {
    const [a] = rrf([['a'], ['x', 'a']], 60);
    expect(a?.score).toBeCloseTo(1 / 61 + 1 / 62);
  });

  it('keeps first-seen order on ties and handles empty input', () => {
    expect(rrf([['a'], ['b']], 60).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rrf([], 60)).toEqual([]);
    expect(rrf([[], []], 60)).toEqual([]);
  });

  it('counts an id once per list', () => {
    const [a] = rrf([['a', 'a']], 60);
    expect(a?.score).toBeCloseTo(1 / 61);
  });
});
