import { describe, expect, it } from 'vite-plus/test';
import {
  formOf,
  json,
  recordingFetch,
  skillSummary,
  skillView,
} from '../test/registry-fixtures.ts';
import { RegistryClient, RegistryError } from './registry.ts';

const conn = { url: 'https://skills.example/', token: 'sk_secret' };
const ref = { slug: 'pdf', version: 1 };
const answering = (res: () => Response) => new RegistryClient(conn, recordingFetch(res).fetch);

describe('RegistryClient', () => {
  it('sends the bearer token and validates answers', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, { login: 'ann', role: 'member' }));
    const me = await new RegistryClient(conn, fetch).me();
    expect(me).toEqual({ login: 'ann', role: 'member' });
    expect(requests[0]?.url).toBe('https://skills.example/api/auth/me');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk_secret');
  });

  it('getSkill: 404 is null; a version goes into the query', async () => {
    const { fetch, requests } = recordingFetch((r) =>
      r.url.includes('missing')
        ? json(404, { error: { code: 'not_found', message: 'no such skill' } })
        : json(200, skillView('pdf')),
    );
    const client = new RegistryClient(conn, fetch);
    expect(await client.getSkill('missing')).toBeNull();
    expect((await client.getSkill('pdf', 3))?.slug).toBe('pdf');
    expect(requests[1]?.url).toBe('https://skills.example/api/skills/pdf?version=3');
  });

  it('turns an error body into RegistryError(status, code)', async () => {
    const { fetch } = recordingFetch(() =>
      json(409, { error: { code: 'skill_exists', message: 'skill "pdf" already exists' } }),
    );
    const err = await new RegistryClient(conn, fetch).getSkill('pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err).toMatchObject({ status: 409, code: 'skill_exists' });
  });

  it('a non-JSON error and an invalid answer are RegistryErrors too', async () => {
    await expect(answering(() => new Response('boom', { status: 502 })).me()).rejects.toMatchObject(
      {
        status: 502,
        code: 'http_502',
      },
    );
    await expect(answering(() => json(200, { login: 1 })).me()).rejects.toMatchObject({
      code: 'bad_response',
    });
    await expect(answering(() => new Response('not json')).me()).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('a network failure is RegistryError(0, network_error)', async () => {
    const fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch;
    await expect(new RegistryClient(conn, fetch).me()).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('listSkills, history, listFolders, getFile build the right URLs', async () => {
    const { fetch, requests } = recordingFetch((r) => {
      if (r.url.includes('/history')) return json(200, []);
      if (r.url.includes('/files/')) return new Response(new Uint8Array([1, 2]));
      if (r.url.includes('/folders')) return json(200, []);
      return json(200, [skillSummary('pdf')]);
    });
    const client = new RegistryClient(conn, fetch);
    expect(
      await client.listSkills({ folder: 'design', q: 'pdf tools', status: 'all' }),
    ).toHaveLength(1);
    await client.listSkills({});
    await client.history('pdf');
    await client.listFolders('all');
    expect(await client.getFile('pdf', 'reference/a b.md', 2)).toEqual(new Uint8Array([1, 2]));
    expect(requests.map((r) => r.url)).toEqual([
      'https://skills.example/api/skills?status=all&folder=design&q=pdf+tools',
      'https://skills.example/api/skills',
      'https://skills.example/api/skills/pdf/history',
      'https://skills.example/api/folders?status=all',
      'https://skills.example/api/skills/pdf/files/reference/a%20b.md?version=2',
    ]);
  });

  it('createFolder posts JSON', async () => {
    const { fetch, requests } = recordingFetch(() => json(201, { slug: 'pdf', name: 'PDF' }));
    const folder = { slug: 'pdf', name: 'PDF', description: 'PDF tools' };
    expect(await new RegistryClient(conn, fetch).createFolder(folder)).toEqual({
      slug: 'pdf',
      name: 'PDF',
    });
    expect(requests[0]).toMatchObject({ method: 'POST', body: folder });
  });

  it('createSkill sends files by path and the source fields', async () => {
    const { fetch, requests } = recordingFetch(() => json(201, ref));
    const files = new Map([
      ['SKILL.md', new TextEncoder().encode('# pdf')],
      ['scripts/run.sh', new Uint8Array([0, 1, 2])],
    ]);
    const client = new RegistryClient(conn, fetch);
    const source = { host: 'github.com', repo: 'o/r', path: '', ref: null, commit: 'a'.repeat(40) };
    expect(
      await client.createSkill({ slug: 'pdf', folder: 'design', files, message: 'm', source }),
    ).toEqual(ref);
    const form = formOf(requests[0]);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('https://skills.example/api/skills');
    expect(form.get('slug')).toBe('pdf');
    expect(form.get('folder')).toBe('design');
    expect(form.get('sourceHost')).toBe('github.com');
    expect(form.get('sourceRepo')).toBe('o/r');
    expect(form.get('sourcePath')).toBe('');
    expect(form.has('sourceRef')).toBe(false);
    expect(form.get('sourceCommit')).toBe('a'.repeat(40));
    const script = form.get('scripts/run.sh');
    expect(script).toBeInstanceOf(Blob);
    if (script instanceof Blob) {
      expect(new Uint8Array(await script.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]));
    }

    await client.createSkill({
      slug: 'x',
      folder: 'design',
      files,
      message: 'm',
      source: { ...source, ref: 'main' },
    });
    await client.createSkill({ slug: 'y', folder: 'design', files, message: 'm', source: null });
    expect(formOf(requests[1]).get('sourceRef')).toBe('main');
    expect(formOf(requests[2]).has('sourceHost')).toBe(false);
  });

  it('publishVersion sends baseVersion, an empty keep and sourceCommit', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, { slug: 'pdf', version: 3 }));
    const client = new RegistryClient(conn, fetch);
    const files = new Map([['SKILL.md', new Uint8Array([35])]]);
    const p = { baseVersion: 2, files, message: 'update', sourceCommit: 'b'.repeat(40) };
    expect(await client.publishVersion('pdf', p)).toEqual({ slug: 'pdf', version: 3 });
    await client.publishVersion('pdf', { ...p, sourceCommit: null });
    const form = formOf(requests[0]);
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      url: 'https://skills.example/api/skills/pdf',
    });
    expect(form.get('baseVersion')).toBe('2');
    expect(form.get('keep')).toBe('[]');
    expect(form.get('sourceCommit')).toBe('b'.repeat(40));
    expect(formOf(requests[1]).has('sourceCommit')).toBe(false);
  });
});
