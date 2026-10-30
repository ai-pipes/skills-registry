import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vite-plus/test';
import {
  chunked,
  member,
  paxRecord,
  rawTarball,
  type TarEntry,
  tarball,
} from '../../test/tarball.ts';
import { MAX_FILES, MAX_SKILL_BYTES } from '../limits.ts';
import { extractTar } from './tar.ts';

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const all = () => true;
const limits = (compressedBytes = 1e9, unpackedBytes = 1e10) => ({
  compressedBytes,
  unpackedBytes,
});
const extract = (entries: TarEntry[], keep: (p: string) => boolean = all) =>
  extractTar(chunked(tarball(entries)), keep, limits());

const fullSkillMd = (i: number) => ({
  path: `s${i}/SKILL.md`,
  content: new Uint8Array(MAX_SKILL_BYTES),
});

describe('extractTar', () => {
  it('strips the root directory and keeps regular files, in small chunks', async () => {
    const binary = new Uint8Array(1500).map((_, i) => i % 256);
    const { files, skipped } = await extract([
      { path: 'skills/', type: '5' },
      { path: 'skills/demo/SKILL.md', content: '# demo' },
      { path: 'skills/demo/bin.dat', content: binary },
      { path: 'skills/demo/empty.txt', content: '' },
    ]);
    expect([...files.keys()]).toEqual([
      'skills/demo/SKILL.md',
      'skills/demo/bin.dat',
      'skills/demo/empty.txt',
    ]);
    expect(text(files.get('skills/demo/SKILL.md'))).toBe('# demo');
    expect(files.get('skills/demo/bin.dat')).toEqual(binary);
    expect(skipped).toEqual([]);
  });

  it('keep drops everything else', async () => {
    const { files } = await extract(
      [
        { path: 'a/SKILL.md', content: 'a' },
        { path: 'b/big.bin', content: new Uint8Array(100_000) },
        { path: 'b/SKILL.md', content: 'b' },
      ],
      (p) => p.startsWith('b/') && p.endsWith('.md'),
    );
    expect([...files.keys()]).toEqual(['b/SKILL.md']);
  });

  it('reads long paths from ustar prefix, pax and GNU L headers', async () => {
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(30)}.md`;
    const { files } = await extract([
      { path: `u/${deep}`, content: 'ustar' },
      { path: `p/${deep}`, content: 'pax', long: 'pax' },
      { path: `g/${deep}`, content: 'gnu', long: 'gnu' },
      { path: 'after.md', content: 'after' },
    ]);
    expect(text(files.get(`u/${deep}`))).toBe('ustar');
    expect(text(files.get(`p/${deep}`))).toBe('pax');
    expect(text(files.get(`g/${deep}`))).toBe('gnu');
    expect(text(files.get('after.md'))).toBe('after');
  });

  it('a pax size applies to the next real member, not to a GNU L or another extended header', async () => {
    const enc = new TextEncoder();
    const long = `r/${'n'.repeat(120)}.md`;
    const pax = (records: string) => member('PaxHeader/x', 'x', enc.encode(records));
    const tar = rawTarball([
      ...pax(paxRecord('size', '5')),
      ...member('././@LongLink', 'L', enc.encode(`${long}\0`)),
      ...member(long.slice(0, 100), '0', enc.encode('hello')),
      ...pax(paxRecord('size', '3')),
      ...member('PaxHeader/g', 'g', enc.encode(paxRecord('comment', 'c'.repeat(40)))),
      ...pax(paxRecord('mtime', '1')),
      ...member('r/b.md', '0', enc.encode('abc')),
    ]);
    const { files } = await extractTar(chunked(tar), all, limits());
    expect(text(files.get(long.slice(2)))).toBe('hello');
    expect(text(files.get('b.md'))).toBe('abc');
  });

  it('reads the ustar prefix only with the POSIX magic, not from an old GNU header', async () => {
    const enc = new TextEncoder();
    const tar = rawTarball([
      ...member('r/a.md', '0', enc.encode('gnu'), { magic: 'gnu', prefix: '14567012345' }),
      ...member('b.md', '0', enc.encode('posix'), { prefix: 'r/p' }),
    ]);
    const { files } = await extractTar(chunked(tar), all, limits());
    expect([...files.keys()]).toEqual(['a.md', 'p/b.md']);
  });

  it('lists symlinks and hard links under keep as skipped, without content', async () => {
    const { files, skipped } = await extract(
      [
        { path: 's/link', type: '2', linkname: '/etc/passwd' },
        { path: 's/hard', type: '1', linkname: 'x/SKILL.md' },
        { path: 'other/link', type: '2', linkname: 'x' },
      ],
      (p) => p.startsWith('s/'),
    );
    expect(files.size).toBe(0);
    expect(skipped).toEqual(['s/link', 's/hard']);
  });

  it('rejects .. and absolute member paths', async () => {
    await expect(extract([{ path: 'root/../evil', raw: true, content: 'x' }])).rejects.toThrow(
      /unsafe path/,
    );
    await expect(extract([{ path: '/etc/passwd', raw: true, content: 'x' }])).rejects.toThrow(
      /unsafe path/,
    );
    await expect(extract([{ path: 'x/../../evil', content: 'x' }], () => false)).rejects.toThrow(
      /unsafe path/,
    );
  });

  it('stops at the compressed size limit', async () => {
    const big = tarball([{ path: 'x.bin', content: crypto.getRandomValues(new Uint8Array(4096)) }]);
    await expect(extractTar(chunked(big, 512), all, limits(1000))).rejects.toThrow(
      'tarball exceeds 1000 bytes',
    );
  });

  it('rejects a tarball cut in the middle of a member', async () => {
    const tar = gunzipSync(tarball([{ path: 'a.md', content: 'x'.repeat(2000) }]));
    const cut = new Uint8Array(gzipSync(tar.subarray(0, 512 * 4)));
    await expect(extractTar(chunked(cut), all, limits())).rejects.toThrow(
      'invalid tarball: truncated',
    );
  });

  it('rejects data that is not a gzip tarball', async () => {
    await expect(extractTar(chunked(new Uint8Array([1, 2, 3, 4])), all, limits())).rejects.toThrow(
      /invalid tarball/,
    );
  });

  it('stops at the decompressed size limit, even for skipped members', async () => {
    // Zeros compress ~1000:1: a small download that would unpack far beyond the cap.
    const bomb = tarball([{ path: 'zeros.bin', content: new Uint8Array(4_000_000) }]);
    await expect(extractTar(chunked(bomb), () => false, limits(1e9, 1_000_000))).rejects.toThrow(
      'tarball unpacks to more than 1000000 bytes',
    );
  });

  it('caps the number of kept members', async () => {
    const many = Array.from({ length: 4 * MAX_FILES + 1 }, (_, i) => ({
      path: `s${i}/SKILL.md`,
      content: 'x',
    }));
    await expect(extract(many)).rejects.toThrow(`more than ${4 * MAX_FILES} matching files`);
    await expect(extract(many.slice(1))).resolves.toBeDefined();
  });

  it('caps the total bytes of kept members', async () => {
    await expect(
      extract([fullSkillMd(0), fullSkillMd(1), fullSkillMd(2), fullSkillMd(3)]),
    ).resolves.toBeDefined();
    await expect(
      extract([
        fullSkillMd(0),
        fullSkillMd(1),
        fullSkillMd(2),
        fullSkillMd(3),
        { path: 'x/SKILL.md', content: 'x' },
      ]),
    ).rejects.toThrow(`matching files exceed ${4 * MAX_SKILL_BYTES} bytes`);
  });
});
