/** `?version=N` as a positive int32, or `undefined` when absent or malformed. */
export function parseVersion(raw: string | null): number | undefined {
  if (raw === null || !/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : undefined;
}
