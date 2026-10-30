import {
  ArchiveFolderResponse,
  AuthConfigResponse,
  FileDiff,
  FolderRef,
  FolderSummary,
  SkillSummary,
  SkillView,
  TokenSummary,
  UserSummary,
  VersionRef,
  VersionSummary,
  type CreateFolderRequest,
  type FolderStatusFilter,
  type SkillStatusFilter,
  type UpdateFolderRequest,
} from '@skills/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, filePath } from './client.ts';

/** Text files up to this size are shown inline; larger ones (and binaries) are only downloaded. */
export const MAX_INLINE_FILE_BYTES = 1_048_576;

/**
 * TanStack Query keys. Every query about one skill starts with `['skill', slug]` and every list
 * with `['skills']`, so a mutation invalidates `skills` and `skill(slug)` and nothing is stale.
 */
export const queryKeys = {
  skills: ['skills'] as const,
  skillList: (status: SkillStatusFilter, q: string, folder: string | null) =>
    ['skills', status, q, folder] as const,
  folders: ['folders'] as const,
  folderList: (status: FolderStatusFilter) => ['folders', status] as const,
  skill: (slug: string) => ['skill', slug] as const,
  skillView: (slug: string, version: number | undefined) =>
    ['skill', slug, 'view', version ?? null] as const,
  skillFile: (slug: string, path: string, version: number | undefined) =>
    ['skill', slug, 'file', path, version ?? null] as const,
  history: (slug: string) => ['skill', slug, 'history'] as const,
  diff: (slug: string, from: number, to: number) => ['skill', slug, 'diff', from, to] as const,
  tokens: ['tokens'] as const,
  users: ['users'] as const,
  authConfig: ['auth-config'] as const,
};

function skillPath(slug: string): string {
  return `/api/skills/${encodeURIComponent(slug)}`;
}

function withVersion(path: string, version: number | undefined): string {
  return version === undefined ? path : `${path}?version=${version}`;
}

/** URL of a skill file, optionally of a given version (download links and inline text). */
export function fileUrl(slug: string, path: string, version?: number): string {
  return withVersion(filePath(slug, path), version);
}

/**
 * `GET /api/skills?status=&q=&folder=`; with a non-empty `q` the order is relevance (server
 * side). `folder` is sent only when set.
 */
export function useSkills({
  status,
  q,
  folder,
}: {
  status: SkillStatusFilter;
  q: string;
  folder?: string | null;
}) {
  return useQuery({
    queryKey: queryKeys.skillList(status, q, folder ?? null),
    queryFn: () => {
      const params = new URLSearchParams({ status });
      if (q !== '') params.set('q', q);
      if (folder) params.set('folder', folder);
      return api.get(`/api/skills?${params}`, SkillSummary.array());
    },
    placeholderData: (previous) => previous,
  });
}

/** `GET /api/folders?status=`, ordered by name as the server sends it. */
export function useFolders(status: FolderStatusFilter = 'active') {
  return useQuery({
    queryKey: queryKeys.folderList(status),
    queryFn: () => api.get(`/api/folders?status=${status}`, FolderSummary.array()),
  });
}

/** `GET /api/skills/:slug[?version=N]`. */
export function useSkill(slug: string, version?: number) {
  return useQuery({
    queryKey: queryKeys.skillView(slug, version),
    queryFn: () => api.get(withVersion(skillPath(slug), version), SkillView),
  });
}

/**
 * A skill file as text. Only for `!binary && size <= MAX_INLINE_FILE_BYTES`: pass
 * `enabled: false` otherwise, and nothing is requested.
 */
export function useSkillFile(slug: string, path: string, version?: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.skillFile(slug, path, version),
    queryFn: () => api.getText(fileUrl(slug, path, version)),
    enabled,
  });
}

/** `GET /api/skills/:slug/history`, newest first as the server sends it. */
export function useHistory(slug: string) {
  return useQuery({
    queryKey: queryKeys.history(slug),
    queryFn: () => api.get(`${skillPath(slug)}/history`, VersionSummary.array()),
  });
}

/** `GET /api/skills/:slug/diff?from=&to=`. */
export function useDiff(slug: string, from: number, to: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.diff(slug, from, to),
    queryFn: () => api.get(`${skillPath(slug)}/diff?from=${from}&to=${to}`, FileDiff.array()),
    enabled,
  });
}

/** `GET /api/tokens`: the signed-in user's tokens. */
export function useTokens() {
  return useQuery({
    queryKey: queryKeys.tokens,
    queryFn: () => api.get('/api/tokens', TokenSummary.array()),
  });
}

/**
 * `GET /api/auth/config` (no session needed): password form or single sign-on. Fixed for the
 * server's lifetime, so it is fetched once.
 */
export function useAuthConfig() {
  return useQuery({
    queryKey: queryKeys.authConfig,
    queryFn: () => api.get('/api/auth/config', AuthConfigResponse),
    staleTime: Infinity,
  });
}

/** `GET /api/users` (admins only). */
export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => api.get('/api/users', UserSummary.array()),
  });
}

/** Lists and every query of `slug` are refetched after a change to the skill. */
function useInvalidateSkill() {
  const client = useQueryClient();
  return (slug: string) =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.skills }),
      client.invalidateQueries({ queryKey: queryKeys.skill(slug) }),
      client.invalidateQueries({ queryKey: queryKeys.folders }),
    ]);
}

/** A folder change cascades (statuses, names on cards): folders, lists and skills are refetched. */
function useInvalidateFolders() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.folders }),
      client.invalidateQueries({ queryKey: queryKeys.skills }),
      client.invalidateQueries({ queryKey: ['skill'] }),
    ]);
}

function folderPath(slug: string): string {
  return `/api/folders/${encodeURIComponent(slug)}`;
}

/** `POST /api/folders`. */
export function useCreateFolder() {
  const invalidate = useInvalidateFolders();
  return useMutation({
    mutationFn: (body: CreateFolderRequest) => api.post('/api/folders', body, FolderRef),
    onSuccess: () => invalidate(),
  });
}

/** `PUT /api/folders/:slug`. */
export function useUpdateFolder(slug: string) {
  const invalidate = useInvalidateFolders();
  return useMutation({
    mutationFn: (body: UpdateFolderRequest) => api.put(folderPath(slug), body, FolderRef),
    onSuccess: () => invalidate(),
  });
}

/** `POST /api/folders/:slug/archive`: archives the folder and its skills. */
export function useArchiveFolder(slug: string) {
  const invalidate = useInvalidateFolders();
  return useMutation({
    mutationFn: () => api.post(`${folderPath(slug)}/archive`, undefined, ArchiveFolderResponse),
    onSuccess: () => invalidate(),
  });
}

/** `POST /api/folders/:slug/restore`. */
export function useRestoreFolder(slug: string) {
  const invalidate = useInvalidateFolders();
  return useMutation({
    mutationFn: () => api.post(`${folderPath(slug)}/restore`),
    onSuccess: () => invalidate(),
  });
}

/** `POST /api/skills/:slug/move`. */
export function useMoveSkill(slug: string) {
  const invalidate = useInvalidateSkill();
  return useMutation({
    mutationFn: (folder: string) => api.post(`${skillPath(slug)}/move`, { folder }),
    onSuccess: () => invalidate(slug),
  });
}

/** `POST /api/skills/:slug/restore` into `folder` (when the skill's own folder is archived). */
export function useRestoreSkillTo(slug: string) {
  const invalidate = useInvalidateSkill();
  return useMutation({
    mutationFn: (folder: string) => api.post(`${skillPath(slug)}/restore`, { folder }),
    onSuccess: () => invalidate(slug),
  });
}

/** `POST /api/skills/:slug/archive` or `/restore`. */
export function useSetArchived(slug: string) {
  const invalidate = useInvalidateSkill();
  return useMutation({
    mutationFn: (archived: boolean) =>
      api.post(`${skillPath(slug)}/${archived ? 'archive' : 'restore'}`),
    onSuccess: () => invalidate(slug),
  });
}

/** `POST /api/skills/:slug/rollback`: a new version restored from `toVersion`. */
export function useRollback(slug: string) {
  const invalidate = useInvalidateSkill();
  return useMutation({
    mutationFn: (body: { toVersion: number; baseVersion: number }) =>
      api.post(`${skillPath(slug)}/rollback`, body, VersionRef),
    // also on a 409: the history is then refetched to show what changed
    onSettled: () => invalidate(slug),
  });
}

/**
 * Saves a skill from a multipart body (`buildUpload`): `POST /api/skills` for a new one,
 * `PUT /api/skills/:slug` for a new version of `slug`.
 */
export function useSaveSkill() {
  const invalidate = useInvalidateSkill();
  return useMutation({
    mutationFn: ({ slug, form }: { slug: string | undefined; form: FormData }) =>
      slug === undefined
        ? api.upload('POST', '/api/skills', form, VersionRef)
        : api.upload('PUT', skillPath(slug), form, VersionRef),
    onSuccess: (ref) => invalidate(ref.slug),
  });
}
