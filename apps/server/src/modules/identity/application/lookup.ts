import type { IdentityDeps } from './ports.ts';

/**
 * Public query for other modules: user id → login. Unknown (or deleted) and malformed ids are
 * simply absent from the map; callers decide how to show them.
 */
export async function loginsByIds(
  deps: Pick<IdentityDeps, 'users'>,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return deps.users.loginsByIds(unique);
}
