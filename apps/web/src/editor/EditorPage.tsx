import { SkillView } from '@skills/contracts';
import { FileIcon, FilePlusIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { notify } from '@/lib/notify.ts';
import { api } from '@/api/client.ts';
import { isApiError } from '@/api/errors.ts';
import { isUnauthorizedRedirect, useAuth } from '@/auth/AuthProvider.tsx';
import {
  fileUrl,
  MAX_INLINE_FILE_BYTES,
  useFolders,
  useSaveSkill,
  useSkill,
  useSkillFile,
} from '@/api/queries.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils.ts';
import { useUnsavedChanges } from '@/lib/unsavedChanges.ts';
import { strings } from '@/strings.ts';
import { buildUpload } from './buildUpload.ts';
import { CodeEditor } from './CodeEditor.tsx';
import {
  clearDraft,
  draftsFrozen,
  loadDraft,
  NEW_DRAFT,
  saveDraft,
  type Draft,
  type DraftFile,
} from './draft.ts';

const SKILL_MD = 'SKILL.md';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DRAFT_DEBOUNCE_MS = 500;
const t = strings.editor;

type BaseFile = SkillView['files'][number];

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The server's `SkillView.files` leaves SKILL.md out (its text is `skillMd`); the editor works
 * on the whole set, so SKILL.md is put back in.
 */
function withSkillMd(view: SkillView): SkillView {
  if (view.files.some((f) => f.path === SKILL_MD)) return view;
  const skillMd = {
    path: SKILL_MD,
    size: utf8Size(view.skillMd),
    binary: false,
    sha256: view.skillMdSha256,
  };
  return { ...view, files: [skillMd, ...view.files] };
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Text of a failed save: the per-code message from strings.ts, if there is one. */
function serverErrorText(error: unknown): string | undefined {
  return isApiError(error) ? t.serverErrors[error.code] : undefined;
}

/**
 * The server's own message for `invalid_frontmatter` (which field, which limit, which line):
 * it names fields and positions, never the SKILL.md text.
 */
function serverErrorDetail(error: unknown): string | undefined {
  return isApiError(error) && error.code === 'invalid_frontmatter' ? error.message : undefined;
}

function skillUrl(slug: string): string {
  return `/skills/${encodeURIComponent(slug)}`;
}

interface Conflict {
  /** The version the edit started from. */
  base: number;
  /** The skill's current version. */
  latest: SkillView;
  /** Kept paths that are gone in `latest` and cannot be turned into text (binary or large). */
  missing: string[];
}

interface EditorProps {
  /** Undefined on the "new skill" page. */
  slug: string | undefined;
  initial: Draft;
  /** Manifest of `initial.baseVersion` (binary flags of kept files); empty for a new skill. */
  baseFiles: BaseFile[];
  restored: boolean;
  /** Active folders to choose from on the "new skill" page. */
  folders?: { slug: string; name: string }[];
}

/**
 * The editor of one text file. A kept file without a cached text is fetched from the base
 * version first. The first edit turns it into a `text` file; the same `CodeEditor` stays
 * mounted through that change (focus, caret and undo history survive).
 */
function FileEditor({
  slug,
  file,
  version,
  onChange,
}: {
  slug: string | undefined;
  file: DraftFile;
  version: number | undefined;
  onChange: (text: string) => void;
}) {
  const fetchBase = file.text === undefined && slug !== undefined && version !== undefined;
  const base = useSkillFile(slug ?? '', file.path, version, fetchBase);
  const text = file.text ?? base.data;
  if (text === undefined) {
    if (base.isError) return <ErrorAlert error={base.error} />;
    return <Skeleton className="h-80 w-full" />;
  }
  return (
    <CodeEditor
      value={text}
      onChange={onChange}
      language={file.path.endsWith('.md') ? 'markdown' : 'text'}
      label={t.editorLabel(file.path)}
    />
  );
}

function SkillEditor({
  slug,
  initial,
  baseFiles: initialBaseFiles,
  restored,
  folders = [],
}: EditorProps) {
  const isNew = slug === undefined;
  const draftName = slug ?? NEW_DRAFT;
  const navigate = useNavigate();
  const saveSkill = useSaveSkill();

  const [slugInput, setSlugInput] = useState(initial.slug);
  const [folderInput, setFolderInput] = useState(initial.folder ?? '');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [message, setMessage] = useState(initial.message);
  const [files, setFiles] = useState<DraftFile[]>(initial.files);
  const [baseVersion, setBaseVersion] = useState(initial.baseVersion);
  const [baseFiles, setBaseFiles] = useState(initialBaseFiles);
  const [reupload, setReupload] = useState(initial.reupload);
  const [selected, setSelected] = useState(SKILL_MD);
  const [dirty, setDirty] = useState(restored);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [newPathError, setNewPathError] = useState<string | null>(null);
  const [uploadFolder, setUploadFolder] = useState('');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);

  const draft: Draft = {
    user: initial.user,
    slug: isNew ? slugInput : slug,
    ...(isNew && folderInput !== '' ? { folder: folderInput } : {}),
    ...(baseVersion === undefined ? {} : { baseVersion }),
    message,
    files,
    reupload,
  };
  // Read outside render (timers, the blocker, unmount): updated after every commit.
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    draftRef.current = draft;
    dirtyRef.current = dirty;
  });
  /** Set once the edit is saved or abandoned: leaving no longer needs a confirmation. */
  const doneRef = useRef(false);

  // The draft follows every change (debounced) and is flushed on unmount, e.g. when a 401
  // sends the visitor to the login page.
  useEffect(() => {
    if (!dirty) return undefined;
    const timer = setTimeout(() => saveDraft(draftName, draftRef.current), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dirty, draftName, slugInput, folderInput, message, files, baseVersion, reupload]);
  useEffect(
    () => () => {
      if (dirtyRef.current && !doneRef.current) saveDraft(draftName, draftRef.current);
    },
    [draftName],
  );

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Lets the shell's "Sign out" ask first too (it is not a route change of this page).
  useUnsavedChanges(dirty);

  // Let through without asking: the login redirect after a 401 (the draft is stored and comes
  // back after it) and the logout's own redirect (the shell already asked, see above).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current &&
      !doneRef.current &&
      !isUnauthorizedRedirect(nextLocation.state) &&
      !draftsFrozen() &&
      nextLocation.pathname !== currentLocation.pathname,
  );
  const leaveRef = useRef(false);

  function setFileText(path: string, text: string) {
    setFiles((prev) =>
      prev.map((f) => (f.path === path ? { path, kind: 'text', text, size: utf8Size(text) } : f)),
    );
    setDirty(true);
  }

  function onSlugChange(next: string) {
    setFiles((prev) =>
      prev.map((f) => {
        // An untouched template follows the slug.
        if (f.path !== SKILL_MD || f.kind !== 'text' || f.text !== t.template(slugInput)) return f;
        const text = t.template(next);
        return { ...f, text, size: utf8Size(text) };
      }),
    );
    setSlugInput(next);
    setSlugError(null);
    setDirty(true);
  }

  function onFolderChange(next: string) {
    setFolderInput(next);
    setFolderError(null);
    setDirty(true);
  }

  function addFile(e: FormEvent) {
    e.preventDefault();
    const path = newPath.trim();
    if (path === '') return setNewPathError(t.pathRequired);
    if (files.some((f) => f.path === path)) return setNewPathError(t.pathExists);
    setFiles((prev) => [...prev, { path, kind: 'text', text: '', size: 0 }]);
    setReupload((prev) => prev.filter((p) => p !== path));
    setNewPath('');
    setNewPathError(null);
    setSelected(path);
    setDirty(true);
  }

  function uploadFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = [...(e.target.files ?? [])];
    e.target.value = '';
    if (picked.length === 0) return;
    const folder = uploadFolder.trim().replace(/^\/+|\/+$/g, '');
    const added: DraftFile[] = picked.map((file) => ({
      path: folder === '' ? file.name : `${folder}/${file.name}`,
      kind: 'upload',
      file,
      size: file.size,
    }));
    const paths = new Set(added.map((f) => f.path));
    setFiles((prev) => [...prev.filter((f) => !paths.has(f.path)), ...added]);
    setReupload((prev) => prev.filter((p) => !paths.has(p)));
    setDirty(true);
  }

  function removeFile(path: string) {
    setFiles((prev) => prev.filter((f) => f.path !== path));
    if (selected === path) setSelected(SKILL_MD);
    setDirty(true);
  }

  async function save(setToSave: DraftFile[], base: number | undefined) {
    if (isNew && !SLUG_RE.test(slugInput)) {
      setSlugError(slugInput === '' ? t.slugRequired : t.slugInvalid);
      return;
    }
    if (isNew && folderInput === '') {
      setFolderError(t.folderRequired);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setFolderError(null);
    // Stored before the request: a 401 leaves for the login page, and the draft must be there.
    saveDraft(draftName, {
      ...draftRef.current,
      files: setToSave,
      ...(base ? { baseVersion: base } : {}),
    });
    try {
      const ref = await saveSkill.mutateAsync({
        slug,
        form: buildUpload({
          ...(isNew ? { slug: slugInput, folder: folderInput } : {}),
          ...(base === undefined ? {} : { baseVersion: base }),
          message,
          files: setToSave,
        }),
      });
      doneRef.current = true;
      clearDraft(draftName);
      setDirty(false);
      notify.success(isNew ? t.created : t.saved(ref.version));
      await navigate(skillUrl(ref.slug));
    } catch (e) {
      if (isApiError(e) && e.status === 401) return; // AuthProvider redirects to the login page
      if (!isNew && base !== undefined && isApiError(e) && e.code === 'version_conflict') {
        try {
          const latest = withSkillMd(
            await api.get(`/api/skills/${encodeURIComponent(slug)}`, SkillView),
          );
          setConflict({ base, latest, missing: [] });
        } catch (loadError) {
          setSaveError(loadError);
        }
        return;
      }
      if (
        isNew &&
        isApiError(e) &&
        (e.code === 'folder_not_found' || e.code === 'folder_archived')
      ) {
        setFolderError(serverErrorText(e) ?? e.message);
        return;
      }
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  /**
   * "Save over version N": the same set on top of N. Kept paths that N no longer has are
   * sent as text, read from the base version; binary or large ones cannot be, so they are listed
   * and nothing is sent. Files N added are kept.
   */
  async function overwrite(c: Conflict) {
    if (slug === undefined) return;
    const latestPaths = new Set(c.latest.files.map((f) => f.path));
    const meta = new Map(baseFiles.map((f) => [f.path, f]));
    const gone = (f: DraftFile) => f.kind === 'kept' && !latestPaths.has(f.path);
    const readable = (f: DraftFile) => {
      const info = meta.get(f.path);
      return f.text !== undefined || (!!info && !info.binary && info.size <= MAX_INLINE_FILE_BYTES);
    };
    const missing = files.filter((f) => gone(f) && !readable(f)).map((f) => f.path);
    if (missing.length > 0) {
      setConflict({ ...c, missing });
      return;
    }
    setSaving(true);
    let next: DraftFile[];
    try {
      const latestSize = new Map(c.latest.files.map((f) => [f.path, f.size]));
      const ours = await Promise.all(
        files.map(async (f): Promise<DraftFile> => {
          if (gone(f)) {
            const text = f.text ?? (await api.getText(fileUrl(slug, f.path, c.base)));
            return { path: f.path, kind: 'text', text, size: utf8Size(text) };
          }
          // Kept now means N's file: a cached text of the old base must not be shown or resent.
          if (f.kind === 'kept') {
            return { path: f.path, kind: 'kept', size: latestSize.get(f.path) ?? f.size };
          }
          return f;
        }),
      );
      // Files N added (in neither our set nor our base) are kept; ones we removed stay removed.
      const known = new Set([...files.map((f) => f.path), ...meta.keys()]);
      const added: DraftFile[] = c.latest.files
        .filter((f) => !known.has(f.path))
        .map((f) => ({ path: f.path, kind: 'kept', size: f.size }));
      next = [...ours, ...added];
    } catch (e) {
      setSaveError(e);
      return;
    } finally {
      setSaving(false);
    }
    setConflict(null);
    setFiles(next);
    setBaseVersion(c.latest.version);
    setBaseFiles(c.latest.files);
    await save(next, c.latest.version);
  }

  const sorted = files.toSorted((a, b) =>
    a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : byPath(a, b),
  );
  const current = files.find((f) => f.path === selected) ?? files.find((f) => f.path === SKILL_MD);
  const errorText = serverErrorText(saveError);
  const errorDetail = serverErrorDetail(saveError);
  const folderItems = [
    { value: '', label: t.folderPlaceholder },
    ...folders.map((f) => ({ value: f.slug, label: f.name })),
  ];
  const title = isNew ? t.newTitle : t.editTitle(slug);

  function fileBody(f: DraftFile | undefined) {
    if (!f) return null;
    if (f.kind === 'upload') {
      return <EmptyState title={f.path} description={t.uploadedFile} />;
    }
    if (f.kind === 'kept' && f.text === undefined) {
      const info = baseFiles.find((b) => b.path === f.path);
      if (!info || info.binary || info.size > MAX_INLINE_FILE_BYTES) {
        return <EmptyState title={f.path} description={t.notEditable} />;
      }
    }
    return (
      <FileEditor
        key={f.path}
        slug={slug}
        file={f}
        version={baseVersion}
        onChange={(text) => setFileText(f.path, text)}
      />
    );
  }

  function badge(f: DraftFile) {
    if (f.kind === 'upload') return t.uploaded;
    return f.kind === 'text' ? t.changed : t.kept;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold break-words">{title}</h1>
      </header>

      {conflict && (
        <Card role="alert" className="border-destructive/50">
          <CardHeader className="gap-3">
            <CardTitle className="flex items-center gap-2">
              <TriangleAlertIcon aria-hidden className="size-4 text-destructive" />
              {t.conflict(conflict.latest.version)}
            </CardTitle>
            {conflict.missing.length > 0 && (
              <CardDescription className="text-destructive">
                {t.conflictMissing(conflict.latest.version, conflict.missing.join(', '))}
              </CardDescription>
            )}
            <div className="flex flex-wrap gap-2">
              <a
                className={buttonVariants({ variant: 'outline' })}
                href={`${skillUrl(slug ?? '')}/diff?from=${conflict.base}&to=${conflict.latest.version}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.viewChanges}
              </a>
              <Button disabled={saving} onClick={() => void overwrite(conflict)}>
                {t.overwrite(conflict.latest.version)}
              </Button>
            </div>
          </CardHeader>
        </Card>
      )}

      {restored && (
        <Card role="status">
          <CardHeader>
            <CardTitle>{t.draftRestored}</CardTitle>
            {reupload.length > 0 && (
              <CardDescription>{t.reupload(reupload.join(', '))}</CardDescription>
            )}
          </CardHeader>
        </Card>
      )}

      {isNew && (
        <div className="flex max-w-md flex-col gap-2">
          <Label id="skill-folder-label">{t.folder}</Label>
          <Select
            items={folderItems}
            value={folderInput}
            onValueChange={(v) => typeof v === 'string' && onFolderChange(v)}
          >
            <SelectTrigger
              aria-labelledby="skill-folder-label"
              aria-invalid={folderError !== null || undefined}
              aria-describedby={folderError ? 'skill-folder-error' : undefined}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {folders.map((f) => (
                <SelectItem key={f.slug} value={f.slug}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {folderError && (
            <p id="skill-folder-error" role="alert" className="text-sm text-destructive">
              {folderError}
            </p>
          )}
          <Label htmlFor="skill-slug">{t.slug}</Label>
          <Input
            id="skill-slug"
            value={slugInput}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={slugError !== null || undefined}
            aria-describedby={slugError ? 'skill-slug-error skill-slug-hint' : 'skill-slug-hint'}
            onChange={(e) => onSlugChange(e.target.value)}
          />
          <p id="skill-slug-hint" className="text-sm text-muted-foreground">
            {t.slugHint}
          </p>
          {slugError && (
            <p id="skill-slug-error" role="alert" className="text-sm text-destructive">
              {slugError}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4 md:border-r md:pr-4">
          <div>
            <h2 className="mb-2 text-sm font-medium">{t.files}</h2>
            <ul className="flex flex-col gap-1">
              {sorted.map((f) => (
                <li key={f.path} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-current={f.path === current?.path || undefined}
                    onClick={() => setSelected(f.path)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted',
                      f.path === current?.path && 'bg-muted font-medium',
                    )}
                  >
                    <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.path}</span>
                    <Badge variant="secondary" className="ml-auto shrink-0">
                      {badge(f)}
                    </Badge>
                  </button>
                  {f.path !== SKILL_MD && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t.remove(f.path)}
                      title={t.removeLabel}
                      onClick={() => removeFile(f.path)}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <form className="flex flex-col gap-2" onSubmit={addFile} noValidate>
            <Label htmlFor="new-file-path">{t.newFilePath}</Label>
            <div className="flex gap-2">
              <Input
                id="new-file-path"
                value={newPath}
                placeholder={t.newFilePlaceholder}
                spellCheck={false}
                aria-invalid={newPathError !== null || undefined}
                aria-describedby={newPathError ? 'new-file-error' : undefined}
                onChange={(e) => {
                  setNewPath(e.target.value);
                  setNewPathError(null);
                }}
              />
              <Button type="submit" variant="outline">
                <FilePlusIcon aria-hidden />
                {t.addFile}
              </Button>
            </div>
            {newPathError && (
              <p id="new-file-error" role="alert" className="text-sm text-destructive">
                {newPathError}
              </p>
            )}
          </form>

          <div className="flex flex-col gap-2">
            <Label htmlFor="upload-folder">{t.uploadFolder}</Label>
            <Input
              id="upload-folder"
              value={uploadFolder}
              placeholder={t.uploadFolderPlaceholder}
              spellCheck={false}
              onChange={(e) => setUploadFolder(e.target.value)}
            />
            <Label htmlFor="upload-files">{t.uploadFiles}</Label>
            <Input id="upload-files" type="file" multiple onChange={uploadFiles} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="font-mono text-sm text-muted-foreground">{current?.path}</h2>
          {fileBody(current)}
        </div>
      </div>

      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save(files, baseVersion);
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="change-message">{t.message}</Label>
          <Textarea
            id="change-message"
            value={message}
            maxLength={2000}
            placeholder={t.messagePlaceholder}
            onChange={(e) => {
              setMessage(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        {saveError !== null &&
          (errorText ? (
            <div role="alert" className="text-sm text-destructive">
              <p>{errorText}</p>
              {errorDetail && <p className="mt-1 font-mono text-xs">{errorDetail}</p>}
            </div>
          ) : (
            <ErrorAlert error={saveError} />
          ))}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? t.saving : t.save}
          </Button>
          <Link
            to={isNew ? '/skills' : skillUrl(slug)}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t.cancel}
          </Link>
        </div>
      </form>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (open || blocker.state !== 'blocked') return;
          if (leaveRef.current) blocker.proceed();
          else blocker.reset();
          leaveRef.current = false;
        }}
        title={t.leaveTitle}
        description={t.leaveDescription}
        confirmLabel={t.leaveConfirm}
        destructive
        onConfirm={() => {
          doneRef.current = true;
          leaveRef.current = true;
          clearDraft(draftName);
        }}
      />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={strings.common.loading}>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

/** `/skills/:slug/edit`: the stored draft (from its own base version) or the current version. */
function EditSkill({ slug, user }: { slug: string; user: string }) {
  // A draft without a base version belongs to the "new skill" page (a skill named `new`).
  const [draft] = useState(() => {
    const d = loadDraft(slug, user);
    return d?.baseVersion === undefined ? null : d;
  });
  const skill = useSkill(slug, draft?.baseVersion);
  const [initial, setInitial] = useState<Draft | null>(draft);

  useEffect(() => {
    // Cached data may be stale (e.g. from the skill page): wait for the refetch, or the first
    // save would start from an old version and hit a spurious conflict.
    if (initial || !skill.data || skill.isFetching) return;
    const view = withSkillMd(skill.data);
    setInitial({
      user,
      slug,
      baseVersion: view.version,
      message: '',
      files: view.files.map((f) =>
        f.path === SKILL_MD
          ? { path: f.path, kind: 'kept', text: view.skillMd, size: f.size }
          : { path: f.path, kind: 'kept', size: f.size },
      ),
      reupload: [],
    });
  }, [initial, skill.data, skill.isFetching, slug, user]);

  if (skill.isError) {
    if (isApiError(skill.error) && skill.error.code === 'skill_not_found') {
      return <EmptyState title={strings.skill.notFound} description={strings.skill.notFoundHint} />;
    }
    return <ErrorAlert error={skill.error} />;
  }
  if (!initial || !skill.data) return <PageSkeleton />;
  return (
    <SkillEditor
      slug={slug}
      initial={initial}
      baseFiles={withSkillMd(skill.data).files}
      restored={draft !== null}
    />
  );
}

/** `/skills/new`: the stored draft, or a SKILL.md template. */
function NewSkill({ user }: { user: string }) {
  const [draft] = useState(() => {
    const d = loadDraft(NEW_DRAFT, user);
    return d?.baseVersion === undefined ? d : null;
  });
  const [params] = useSearchParams();
  const folders = useFolders('active');
  if (folders.isError) return <ErrorAlert error={folders.error} />;
  if (folders.data === undefined) return <PageSkeleton />;
  if (folders.data.length === 0) {
    return (
      <EmptyState
        title={t.noFoldersTitle}
        description={t.noFoldersHint}
        action={
          <Link to="/folders/new" className={buttonVariants()}>
            {t.createFolder}
          </Link>
        }
      />
    );
  }
  const wanted = params.get('folder') ?? '';
  const preselected = folders.data.some((f) => f.slug === wanted) ? wanted : '';
  const initial: Draft = draft ?? {
    user,
    slug: '',
    ...(preselected === '' ? {} : { folder: preselected }),
    message: '',
    files: [{ path: SKILL_MD, kind: 'text', text: t.template(''), size: utf8Size(t.template('')) }],
    reupload: [],
  };
  return (
    <SkillEditor
      slug={undefined}
      initial={initial}
      baseFiles={[]}
      restored={draft !== null}
      folders={folders.data}
    />
  );
}

/** `/skills/new` and `/skills/:slug/edit`. */
export function EditorPage() {
  const { slug } = useParams();
  // Drafts belong to the signed-in user (the page is only reachable signed in).
  const user = useAuth().me?.login ?? '';
  return slug === undefined ? (
    <NewSkill key={user} user={user} />
  ) : (
    <EditSkill key={`${user}\n${slug}`} slug={slug} user={user} />
  );
}
