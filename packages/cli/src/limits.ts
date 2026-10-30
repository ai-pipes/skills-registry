import { UsageError } from './args.ts';

// Registry limits (the server enforces the same ones); checked on the client before uploading.
export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_SKILL_BYTES = 10_485_760;
/** File path: whole and per `/`-segment, in characters. */
export const MAX_PATH = 255;
export const MAX_SEGMENT = 100;

/** Caps on reading a GitHub tarball (the whole repository is downloaded and unpacked). */
export type TarLimits = {
  /** Compressed stream: 200 MiB, or `SKILLS_REGISTRY_MAX_TARBALL_BYTES`. */
  compressedBytes: number;
  /** Decompressed stream (kept and skipped members alike): 1 GiB, or `SKILLS_REGISTRY_MAX_UNPACKED_BYTES`. */
  unpackedBytes: number;
};

function positiveInt(
  vars: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = vars[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`${key} must be a positive integer`);
  }
  return n;
}

export function tarLimits(vars: Record<string, string | undefined>): TarLimits {
  return {
    compressedBytes: positiveInt(vars, 'SKILLS_REGISTRY_MAX_TARBALL_BYTES', 209_715_200),
    unpackedBytes: positiveInt(vars, 'SKILLS_REGISTRY_MAX_UNPACKED_BYTES', 1_073_741_824),
  };
}
