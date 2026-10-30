import type { DraftFile } from './draft.ts';

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Multipart body of `POST /api/skills` (with `slug`) or `PUT /api/skills/:slug` (with
 * `baseVersion`); `folder` only when creating. Every file part's field name is its path: `text` files as UTF-8 `Blob`s,
 * `upload`s as their `File`. On a publish, `kept` paths go into `keep` (a JSON array).
 */
export function buildUpload(p: {
  slug?: string;
  folder?: string;
  baseVersion?: number;
  message: string;
  files: DraftFile[];
}): FormData {
  const form = new FormData();
  if (p.slug !== undefined) form.append('slug', p.slug);
  if (p.folder !== undefined) form.append('folder', p.folder);
  if (p.baseVersion !== undefined) form.append('baseVersion', String(p.baseVersion));
  form.append('message', p.message);
  if (p.baseVersion !== undefined) {
    const keep = p.files.filter((f) => f.kind === 'kept').map((f) => f.path);
    form.append('keep', JSON.stringify(keep));
  }
  for (const f of p.files) {
    if (f.kind === 'text') {
      const blob = new Blob([f.text ?? ''], { type: 'text/plain;charset=utf-8' });
      form.append(f.path, blob, basename(f.path));
    } else if (f.kind === 'upload' && f.file) {
      form.append(f.path, f.file, basename(f.path));
    }
  }
  return form;
}
