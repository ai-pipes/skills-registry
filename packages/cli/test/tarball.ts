import { gzipSync } from 'node:zlib';

/** One archive member. `path` is relative to the archive's root directory unless `raw`. */
export type TarEntry = {
  path: string;
  content?: string | Uint8Array;
  /** Tar type flag: `0` file (default), `2` symlink, `1` hard link, `5` directory. */
  type?: '0' | '1' | '2' | '5';
  linkname?: string;
  /** How a name longer than 100 bytes is stored (default: ustar `prefix`). */
  long?: 'ustar' | 'pax' | 'gnu';
  /** Use `path` as the full member name (no root directory), e.g. for `../evil`. */
  raw?: boolean;
};

const enc = new TextEncoder();
const bytesOf = (c: string | Uint8Array | undefined) =>
  c === undefined ? new Uint8Array() : typeof c === 'string' ? enc.encode(c) : c;

function writeString(h: Uint8Array, offset: number, length: number, value: string): void {
  const b = enc.encode(value);
  if (b.length > length) throw new Error(`tar field too long: ${value}`);
  h.set(b, offset);
}

function writeOctal(h: Uint8Array, offset: number, length: number, value: number): void {
  writeString(h, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(p: {
  name: string;
  size: number;
  type: string;
  prefix?: string;
  linkname?: string;
  /** `gnu`: old GNU magic `ustar  \0`; offset 345 then holds GNU fields, not a prefix. */
  magic?: 'posix' | 'gnu';
}): Uint8Array {
  const h = new Uint8Array(512);
  writeString(h, 0, 100, p.name);
  writeOctal(h, 100, 8, p.type === '5' ? 0o755 : 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, p.size);
  writeOctal(h, 136, 12, 1_700_000_000);
  h.fill(0x20, 148, 156);
  writeString(h, 156, 1, p.type);
  writeString(h, 157, 100, p.linkname ?? '');
  writeString(h, 257, 8, p.magic === 'gnu' ? 'ustar  \0' : 'ustar\x0000');
  writeString(h, 345, 155, p.prefix ?? '');
  const sum = h.reduce((a, b) => a + b, 0);
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** One member's header, data and padding (for hand-built archives, see `rawTarball`). */
export function member(
  name: string,
  type: string,
  data: Uint8Array,
  extra: { prefix?: string; linkname?: string; magic?: 'posix' | 'gnu' } = {},
): Uint8Array[] {
  return [header({ name, size: data.length, type, ...extra }), data, pad(data.length)];
}

export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = enc.encode(body).length;
  while (enc.encode(`${len}${body}`).length !== len) len = enc.encode(`${len}${body}`).length;
  return `${len}${body}`;
}

function splitUstar(name: string): { name: string; prefix: string } {
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1)) {
    const rest = name.slice(i + 1);
    if (enc.encode(rest).length <= 100 && i <= 155) return { name: rest, prefix: name.slice(0, i) };
  }
  throw new Error(`cannot split ${name} for ustar`);
}

/**
 * A gzip-compressed tarball shaped like GitHub's: a pax global header with the commit, then every
 * member under `root/` (e.g. `acme-skills-0123abc/skills/demo/SKILL.md`).
 */
export function tarball(entries: TarEntry[], root = 'acme-skills-0123abc'): Uint8Array {
  const parts: Uint8Array[] = [
    ...member('pax_global_header', 'g', enc.encode(paxRecord('comment', 'a'.repeat(40)))),
    ...member(`${root}/`, '5', new Uint8Array()),
  ];
  for (const e of entries) {
    const name = e.raw ? e.path : `${root}/${e.path}`;
    const type = e.type ?? '0';
    const data = type === '0' ? bytesOf(e.content) : new Uint8Array();
    const link = e.linkname === undefined ? {} : { linkname: e.linkname };
    if (enc.encode(name).length <= 100) {
      parts.push(...member(name, type, data, link));
    } else if (e.long === 'pax') {
      parts.push(...member('PaxHeader/long', 'x', enc.encode(paxRecord('path', name))));
      parts.push(...member(name.slice(0, 100), type, data, link));
    } else if (e.long === 'gnu') {
      parts.push(...member('././@LongLink', 'L', enc.encode(`${name}\0`)));
      parts.push(...member(name.slice(0, 100), type, data, link));
    } else {
      parts.push(...member(splitUstar(name).name, type, data, { ...link, ...splitUstar(name) }));
    }
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

/** A gzip tarball of hand-built members (full names), plus the end-of-archive blocks. */
export function rawTarball(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.concat([...parts, new Uint8Array(1024)])));
}

/** The bytes as a stream of small chunks, so parsers see headers split across reads. */
export function chunked(bytes: Uint8Array, size = 7): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const notFound = () =>
  new Response(JSON.stringify({ message: 'Not Found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

/** A repository of the fake GitHub: default branch, ref → commit, commit → tarball. */
export type FakeRepo = {
  defaultBranch: string;
  refs: Record<string, string>;
  tarballs: Record<string, Uint8Array>;
};

/**
 * A fake GitHub REST API at `apiUrl` (`/repos/{repo}`, `/commits/{ref}` with the sha media type,
 * `/tarball/{sha}`); anything else is 404. `rateLimited` answers 403 with no requests left.
 */
export function fakeGithub(
  repos: Record<string, FakeRepo>,
  opts: { apiUrl?: string; rateLimited?: boolean } = {},
): { fetch: typeof fetch; requests: Request[] } {
  const apiUrl = opts.apiUrl ?? 'http://gh.test';
  const requests: Request[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (opts.rateLimited) {
      return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    }
    if (!req.url.startsWith(`${apiUrl}/repos/`)) return notFound();
    const rest = req.url.slice(`${apiUrl}/repos/`.length).split('/').map(decodeURIComponent);
    const repo = repos[`${rest[0]}/${rest[1]}`];
    if (repo === undefined) return notFound();
    if (rest.length === 2) return Response.json({ default_branch: repo.defaultBranch });
    const arg = rest.slice(3).join('/');
    if (rest[2] === 'commits') {
      const sha = repo.refs[arg] ?? (arg in repo.tarballs ? arg : undefined);
      if (sha === undefined) return notFound();
      if (req.headers.get('accept') !== 'application/vnd.github.sha') return Response.json({ sha });
      return new Response(sha);
    }
    const tar = rest[2] === 'tarball' ? repo.tarballs[arg] : undefined;
    return tar === undefined ? notFound() : new Response(chunked(tar, 4096));
  };
  return { fetch: fetchFn, requests };
}
