import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { OpenAiCompatibleEmbedder } from './openai-compatible-embedder.ts';

const vec = (x: number) => Array.from({ length: 384 }, () => x);

function stubFetch(response: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json(response, { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sentBody = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : 'null');

afterEach(() => {
  vi.unstubAllGlobals();
});

const embedder = () => new OpenAiCompatibleEmbedder({ url: 'http://emb:8080/v1/', model: 'e5' });

describe('OpenAiCompatibleEmbedder', () => {
  it('posts prefixed input to /embeddings and returns vectors in index order', async () => {
    const fetchMock = stubFetch({
      data: [
        { index: 1, embedding: vec(2) },
        { index: 0, embedding: vec(1) },
      ],
    });
    expect(await embedder().embedPassages(['a', 'b'])).toEqual([vec(1), vec(2)]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://emb:8080/v1/embeddings');
    expect(sentBody(init)).toEqual({
      model: 'e5',
      input: ['passage: a', 'passage: b'],
    });
  });

  it('prefixes queries', async () => {
    const fetchMock = stubFetch({ data: [{ index: 0, embedding: vec(1) }] });
    expect(await embedder().embedQuery('q')).toEqual(vec(1));
    expect(sentBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({ input: ['query: q'] });
  });

  it('rejects wrong dimensions, wrong count and HTTP errors', async () => {
    stubFetch({ data: [{ index: 0, embedding: [1, 2, 3] }] });
    await expect(embedder().embedQuery('q')).rejects.toThrow('384');
    stubFetch({ data: [] });
    await expect(embedder().embedQuery('q')).rejects.toThrow('384');
    stubFetch({ error: 'x' }, 500);
    await expect(embedder().embedQuery('q')).rejects.toThrow('HTTP 500');
  });

  it('skips the request for an empty batch and is always ready', async () => {
    const fetchMock = stubFetch({ data: [] });
    expect(await embedder().embedPassages([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await embedder().ready()).toBe(true);
  });
});
