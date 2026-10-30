import type { Context } from 'hono';
import { z } from 'zod';
import { invalidRequest } from '../../../../platform/http/errors.ts';
import { readMultipart } from '../../../../platform/http/request.ts';
import type { FileInput } from '../../application/file-input.ts';
import { MAX_FILE_BYTES, MAX_FILES_PER_SKILL, MAX_SKILL_BYTES } from '../../application/limits.ts';
import { CatalogError } from '../../domain/errors.ts';

/** Body caps for upload routes: the catalog limit plus room for multipart framing. */
export const UPLOAD_BODY_LIMITS = {
  skill: MAX_SKILL_BYTES + 1_048_576,
} as const;

const tooLarge = (message: string) => new CatalogError('limit_exceeded', message);

/** Reads a skill upload: text fields per `schema`, every file part's field name is its path. */
export async function readSkillUpload<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ fields: z.output<S>; files: FileInput[] }> {
  const { fields, files } = await readMultipart(c, schema);
  if (files.length > MAX_FILES_PER_SKILL) {
    throw tooLarge(`a skill may contain at most ${MAX_FILES_PER_SKILL} files`);
  }
  let total = 0;
  for (const [, file] of files) {
    if (file.size > MAX_FILE_BYTES) throw tooLarge(`a file exceeds ${MAX_FILE_BYTES} bytes`);
    total += file.size;
  }
  if (total > MAX_SKILL_BYTES) throw tooLarge(`skill exceeds ${MAX_SKILL_BYTES} bytes in total`);
  const inputs = await Promise.all(
    files.map(async ([path, file]) => ({ path, bytes: new Uint8Array(await file.arrayBuffer()) })),
  );
  return { fields, files: inputs };
}

const KeepPaths = z.array(z.string().max(4096)).max(MAX_FILES_PER_SKILL);

/** Parses the `keep` field of a publish upload: a JSON array of base-version paths. */
export function parseKeep(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidRequest('keep must be a JSON array of paths');
  }
  const paths = KeepPaths.safeParse(value);
  if (!paths.success) {
    throw invalidRequest(`keep must be a JSON array of at most ${MAX_FILES_PER_SKILL} paths`);
  }
  return paths.data;
}
