import type { Sql, Tx } from '../../../platform/db.ts';
import type { BlobStore } from '../application/ports.ts';
import type { ContentHash } from '../domain/content-hash.ts';

export class PgBlobStore implements BlobStore {
  constructor(private readonly sql: Sql) {}

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    const [row] = await this.sql<{ bytes: Buffer }[]>`
      select bytes from catalog.blobs where hash = ${hash.value}`;
    return row ? new Uint8Array(row.bytes) : null;
  }
}

/** Content-addressed insert; identical content is stored once. Runs inside the caller's transaction. */
export async function putBlobs(tx: Tx, blobs: Map<string, Uint8Array>): Promise<void> {
  if (blobs.size === 0) return;
  const rows = JSON.stringify(
    [...blobs].map(([hash, bytes]) => ({ hash, b64: Buffer.from(bytes).toString('base64') })),
  );
  await tx`insert into catalog.blobs (hash, bytes, size)
    select x.hash, decode(x.b64, 'base64'), octet_length(decode(x.b64, 'base64'))
    from jsonb_to_recordset(${rows}::text::jsonb) as x(hash text, b64 text)
    on conflict (hash) do nothing`;
}
