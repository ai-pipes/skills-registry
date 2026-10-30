import { MAX_FILES, MAX_SKILL_BYTES, type TarLimits } from '../limits.ts';

const BLOCK = 512;
/** Extended headers (pax `x`, GNU `L`) bigger than this are not a real path. */
const MAX_EXTENDED_HEADER = 1_048_576;
/**
 * Caps on what `keep` lets through. A first pass keeps every SKILL.md of the repository, so a
 * huge or hostile repository must not fill memory: a few skills' worth is plenty.
 */
const MAX_KEPT_BYTES = 4 * MAX_SKILL_BYTES;
const MAX_KEPT_MEMBERS = 4 * MAX_FILES;

/** A FIFO of byte chunks: append, take or skip from the front without re-concatenating. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private head = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Copies the first `n` bytes out (`out`) or drops them (`out` undefined). */
  private consume(n: number, out?: Uint8Array): void {
    let done = 0;
    while (done < n) {
      const chunk = this.chunks[0];
      if (chunk === undefined) throw new Error('ByteQueue underflow');
      const k = Math.min(chunk.length - this.head, n - done);
      out?.set(chunk.subarray(this.head, this.head + k), done);
      done += k;
      this.head += k;
      if (this.head === chunk.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.length -= n;
  }

  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    this.consume(n, out);
    return out;
  }

  skip(n: number): void {
    this.consume(n);
  }
}

const utf8 = new TextDecoder();

/** A NUL-terminated header field. */
function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(field: Uint8Array): number {
  // GNU base-256 for values that do not fit in octal digits.
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let n = (field[0] ?? 0) & 0x7f;
    for (const b of field.subarray(1)) n = n * 256 + b;
    return n;
  }
  const text = cString(field).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('invalid tarball: bad number in header');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function checkChecksum(h: Uint8Array): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
  if (sum !== octal(h.subarray(148, 156))) throw new Error('invalid tarball: bad header checksum');
}

/** pax records: `<len> <key>=<value>\n`. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number(utf8.decode(data.subarray(i, space)));
    if (!Number.isInteger(len) || len <= space - i || i + len > data.length) {
      throw new Error('invalid tarball: bad pax header');
    }
    // `<len>` counts the whole record in bytes, including the trailing newline.
    const body = utf8.decode(data.subarray(space + 1, i + len - 1));
    const eq = body.indexOf('=');
    if (eq > 0) out.set(body.slice(0, eq), body.slice(eq + 1));
    i += len;
  }
  return out;
}

/**
 * The member path without the archive's root directory (`owner-repo-sha/`), as is (callers decide
 * what to do with `./`, `//` or `\\`), or `null` for the root itself. Absolute paths, `..` and NUL
 * make the whole archive unsafe.
 */
function memberPath(name: string): string | null {
  if (name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) {
    throw new Error(`unsafe path in tarball: ${JSON.stringify(name)}`);
  }
  const slash = name.indexOf('/');
  const rest = slash === -1 ? '' : name.slice(slash + 1);
  return rest === '' ? null : rest;
}

type Extracted = { files: Map<string, Uint8Array>; skipped: string[] };

/**
 * A synchronous tar parser fed decompressed chunks as they arrive: it waits for a whole header,
 * then either collects the member's data or skips it (without buffering skipped data).
 */
class TarParser {
  readonly out: Extracted = { files: new Map(), skipped: [] };
  private readonly queue = new ByteQueue();
  private state: 'header' | 'body' | 'skip' | 'done' = 'header';
  /** Bytes still to collect (`body`) or drop (`skip`). */
  private pending = 0;
  /** Padding to drop after the collected body. */
  private padAfter = 0;
  private onBody: (data: Uint8Array) => void = () => undefined;
  private paxPath: string | null = null;
  private paxSize: number | null = null;
  private longName: string | null = null;
  private keptBytes = 0;
  private keptMembers = 0;

  constructor(private readonly keep: (path: string) => boolean) {}

  push(chunk: Uint8Array): void {
    this.queue.push(chunk);
    for (;;) {
      if (this.state === 'done') {
        this.queue.skip(this.queue.length);
        return;
      }
      if (this.state === 'skip') {
        const k = Math.min(this.queue.length, this.pending);
        this.queue.skip(k);
        this.pending -= k;
        if (this.pending > 0) return;
        this.state = 'header';
      } else if (this.state === 'body') {
        if (this.queue.length < this.pending) return;
        const data = this.queue.take(this.pending);
        this.skip(this.padAfter);
        this.onBody(data);
      } else {
        if (this.queue.length < BLOCK) return;
        this.header(this.queue.take(BLOCK));
      }
    }
  }

  /** End of the decompressed stream: only valid between members. */
  end(): void {
    const between = this.state === 'header' || (this.state === 'skip' && this.pending === 0);
    if (this.state !== 'done' && !(between && this.queue.length === 0)) {
      throw new Error('invalid tarball: truncated');
    }
  }

  private skip(n: number): void {
    this.state = 'skip';
    this.pending = n;
  }

  private collect(n: number, padding: number, onBody: (data: Uint8Array) => void): void {
    this.state = 'body';
    this.pending = n;
    this.padAfter = padding;
    this.onBody = onBody;
  }

  private header(h: Uint8Array): void {
    if (h.every((b) => b === 0)) {
      this.state = 'done';
      return;
    }
    checkChecksum(h);
    const type = String.fromCharCode(h[156] ?? 0);
    const extended = type === 'x' || type === 'L' || type === 'g' || type === 'K';
    // A pax `size` describes the next real member, never another extended header.
    const size = (extended ? null : this.paxSize) ?? octal(h.subarray(124, 136));
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === 'x' || type === 'L') {
      if (size > MAX_EXTENDED_HEADER) throw new Error('invalid tarball: extended header too large');
      this.collect(size, padding, (data) => this.extended(type, data));
      return;
    }
    if (type === 'g' || type === 'K') {
      this.skip(size + padding);
      return;
    }
    const ustarName = cString(h.subarray(0, 100));
    const prefix = cString(h.subarray(345, 500));
    // Only POSIX ustar has a prefix there; old GNU (`ustar  \0`) keeps other fields at 345.
    const isUstar = utf8.decode(h.subarray(257, 265)) === 'ustar\x0000';
    const name =
      this.paxPath ??
      this.longName ??
      (isUstar && prefix !== '' ? `${prefix}/${ustarName}` : ustarName);
    this.paxPath = null;
    this.paxSize = null;
    this.longName = null;
    const path = memberPath(name);
    if (path === null || type === '5' || !this.keep(path)) {
      this.skip(size + padding);
      return;
    }
    if (++this.keptMembers > MAX_KEPT_MEMBERS) {
      throw new Error(
        `tarball has more than ${MAX_KEPT_MEMBERS} matching files; pass the skill's path`,
      );
    }
    if (type !== '0' && type !== '\0') {
      this.out.skipped.push(path);
      this.skip(size + padding);
    } else {
      if (size > MAX_SKILL_BYTES) throw new Error(`${path}: file exceeds ${MAX_SKILL_BYTES} bytes`);
      this.keptBytes += size;
      if (this.keptBytes > MAX_KEPT_BYTES) {
        throw new Error(`matching files exceed ${MAX_KEPT_BYTES} bytes; pass the skill's path`);
      }
      this.collect(size, padding, (data) => this.out.files.set(path, data));
    }
  }

  private extended(type: 'x' | 'L', data: Uint8Array): void {
    if (type === 'L') {
      this.longName = cString(data);
      return;
    }
    const records = paxRecords(data);
    this.paxPath = records.get('path') ?? this.paxPath;
    const size = records.get('size');
    if (size !== undefined) {
      if (!/^\d+$/.test(size)) throw new Error('invalid tarball: bad pax size');
      this.paxSize = Number(size);
    }
  }
}

/**
 * Reads a gzip tarball as it streams in and keeps only regular files whose path (without the root
 * directory) passes `keep`; other member types that pass `keep` are listed in `skipped`. Stops at
 * `limits` (compressed and decompressed bytes) and at a few skills' worth of kept members.
 * Understands ustar `prefix`, pax `x` (`path`, `size`), pax `g` (ignored) and GNU `L`.
 */
export async function extractTar(
  stream: ReadableStream<Uint8Array>,
  keep: (path: string) => boolean,
  limits: TarLimits,
): Promise<Extracted> {
  const tooBig = new Error(`tarball exceeds ${limits.compressedBytes} bytes`);
  let compressed = 0;
  let unpacked = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      compressed += chunk.length;
      if (compressed > limits.compressedBytes) controller.error(tooBig);
      else controller.enqueue(new Uint8Array(chunk));
    },
  });
  const parser = new TarParser(keep);
  let parseError: unknown = null;
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      try {
        unpacked += chunk.length;
        if (unpacked > limits.unpackedBytes) {
          throw new Error(`tarball unpacks to more than ${limits.unpackedBytes} bytes`);
        }
        parser.push(chunk);
      } catch (e) {
        parseError = e;
        throw e;
      }
    },
    close() {
      parser.end();
    },
  });
  try {
    await stream.pipeThrough(counter).pipeThrough(new DecompressionStream('gzip')).pipeTo(sink);
  } catch (e) {
    if (e === tooBig || (e !== null && e === parseError)) throw e;
    if (e instanceof Error && e.message.startsWith('invalid tarball')) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid tarball: ${reason}`, { cause: e });
  }
  return parser.out;
}
