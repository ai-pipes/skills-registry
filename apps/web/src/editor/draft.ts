import { z } from 'zod';

/**
 * One file of the set being edited:
 * - `kept` — the base version's file, unchanged (sent in `keep`; `text` may cache its content);
 * - `text` — edited in the browser, sent as a UTF-8 part;
 * - `upload` — picked from disk, sent as the `File` itself.
 */
export type DraftFile = {
  path: string;
  kind: 'kept' | 'text' | 'upload';
  text?: string;
  file?: File;
  size: number;
};

/** Unsaved editor state, kept in `sessionStorage` so a reload or a re-login does not lose it. */
export interface Draft {
  /** Login of the user who wrote it: another user signed in on the same tab never sees it. */
  user: string;
  /** The slug typed on the "new skill" page; the skill's own slug when editing. */
  slug: string;
  /** Folder chosen on the "new skill" page. */
  folder?: string;
  /** Version the edit started from; absent for a new skill. */
  baseVersion?: number;
  message: string;
  files: DraftFile[];
  /** Uploaded files a stored draft cannot hold: their paths, to be uploaded again. */
  reupload: string[];
}

/** Draft name of the "new skill" page (`draft:new`). */
export const NEW_DRAFT = 'new';

const PREFIX = 'draft:';

export function draftKey(slug: string): string {
  return `${PREFIX}${slug}`;
}

/** While true (a logout is in progress or done), `saveDraft` writes nothing. */
let frozen = false;

/**
 * Stops draft writes (pending debounced saves, the editor's unmount flush) from the start of a
 * logout; `unfreezeDrafts()` undoes it when the logout fails or at the next login.
 */
export function freezeDrafts(): void {
  frozen = true;
}

export function unfreezeDrafts(): void {
  frozen = false;
}

/** True from the start of a logout until the next login (or the logout failing). */
export function draftsFrozen(): boolean {
  return frozen;
}

/** Removes every stored draft (after a logout: the next user of the tab must not see them). */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing stored either.
  }
}

const StoredFile = z.union([
  z.object({ path: z.string(), kind: z.literal('kept'), size: z.number() }),
  z.object({ path: z.string(), kind: z.literal('text'), text: z.string(), size: z.number() }),
]);

const StoredDraft = z.object({
  user: z.string(),
  slug: z.string(),
  folder: z.string().optional(),
  baseVersion: z.number().int().min(1).optional(),
  message: z.string(),
  files: z.array(StoredFile),
  reupload: z.array(z.string()),
});

/**
 * Stores the draft. Uploads are not stored (a `File` does not survive serialization): only their
 * paths, in `reupload`. Cached base texts of kept files are dropped too. Storage errors (quota,
 * disabled storage) are swallowed: the draft is a safety net, not the source of truth.
 */
export function saveDraft(slug: string, d: Draft): void {
  if (frozen) return;
  const files: z.infer<typeof StoredFile>[] = [];
  const reupload = new Set(d.reupload);
  for (const f of d.files) {
    if (f.kind === 'kept') files.push({ path: f.path, kind: 'kept', size: f.size });
    else if (f.kind === 'text') {
      files.push({ path: f.path, kind: 'text', text: f.text ?? '', size: f.size });
    } else reupload.add(f.path);
  }
  const stored: z.infer<typeof StoredDraft> = {
    user: d.user,
    slug: d.slug,
    ...(d.folder === undefined ? {} : { folder: d.folder }),
    ...(d.baseVersion === undefined ? {} : { baseVersion: d.baseVersion }),
    message: d.message,
    files,
    reupload: [...reupload],
  };
  try {
    sessionStorage.setItem(draftKey(slug), JSON.stringify(stored));
  } catch {
    // Quota exceeded or storage unavailable: nothing to do.
  }
}

/**
 * The stored draft of `user`, or null when there is none, it does not parse, or another user
 * wrote it (that one is removed).
 */
export function loadDraft(slug: string, user: string): Draft | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(draftKey(slug));
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredDraft.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.user !== user) {
    clearDraft(slug);
    return null;
  }
  const { baseVersion, folder, ...rest } = parsed.data;
  return {
    ...rest,
    ...(folder === undefined ? {} : { folder }),
    ...(baseVersion === undefined ? {} : { baseVersion }),
  };
}

export function clearDraft(slug: string): void {
  try {
    sessionStorage.removeItem(draftKey(slug));
  } catch {
    // Storage unavailable: nothing stored either.
  }
}
