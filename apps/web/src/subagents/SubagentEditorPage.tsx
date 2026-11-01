import { SubagentModel, type FolderRef, type SubagentView } from '@skills/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { isApiError } from '@/api/errors.ts';
import { useCreateSubagent, useFolders, usePublishSubagent, useSubagent } from '@/api/queries.ts';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { PageSkeleton } from '@/components/PageSkeleton.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { CodeEditor } from '@/editor/CodeEditor.tsx';
import { notify } from '@/lib/notify.ts';
import { useLeaveGuard } from '@/lib/useLeaveGuard.tsx';
import { FolderPicker } from '@/skills/FolderPicker.tsx';
import { strings } from '@/strings.ts';
import {
  emptySubagentForm,
  parseSubagentForm,
  serializeSubagentForm,
  type SubagentForm,
} from './subagent-md.ts';
import { SkillsField } from './SkillsField.tsx';
import { toolsMissing, ToolsField } from './ToolsField.tsx';

const t = strings.subagentEditor;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1024;

type Mode = 'form' | 'raw';
type ErrorTarget = 'skills' | 'tools' | 'folder' | 'top';

/** Where a failed save is shown: under the field it names (Form tab only) or above the form. */
function classifyError(error: unknown, mode: Mode, isNew: boolean): ErrorTarget {
  if (!isApiError(error) || mode === 'raw') return 'top';
  if (error.code === 'unknown_skill') return 'skills';
  if (error.code === 'invalid_frontmatter' && /tools/i.test(error.message)) return 'tools';
  if (isNew && (error.code === 'folder_not_found' || error.code === 'folder_archived')) {
    return 'folder';
  }
  return 'top';
}

/** Text of a failed save: the per-code message plus the server's own detail for frontmatter. */
function errorText(error: unknown): { text: string; detail?: string } | null {
  if (!isApiError(error)) return null;
  if (error.code === 'version_conflict') return { text: t.conflict };
  const text = t.serverErrors[error.code];
  if (text === undefined) return null;
  const withDetail = error.code === 'invalid_frontmatter' || error.code === 'unknown_skill';
  return withDetail ? { text, detail: error.message } : { text };
}

function subagentUrl(slug: string): string {
  return `/subagents/${encodeURIComponent(slug)}`;
}

interface FieldErrorProps {
  id: string;
  children: string;
}

function FieldError({ id, children }: FieldErrorProps) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function ServerError({ error }: { error: unknown }) {
  const known = errorText(error);
  if (known === null) return <ErrorAlert error={error} />;
  return (
    <div role="alert" className="text-sm text-destructive">
      <p>{known.text}</p>
      {known.detail && <p className="mt-1 font-mono text-xs">{known.detail}</p>}
    </div>
  );
}

const MODEL_ITEMS = SubagentModel.options.map((m) => ({ value: m, label: m }));

interface EditorProps {
  /** Undefined on the "new subagent" page. */
  slug: string | undefined;
  initialText: string;
  initialForm: SubagentForm;
  /** Why `initialText` does not parse into the form; the editor then opens in Raw mode. */
  initialParseError?: string | undefined;
  /** The version the edit starts from; undefined when creating. */
  baseVersion: number | undefined;
  initialFolder: string;
  /** Active folders to choose from when creating. */
  folders: FolderRef[];
}

function SubagentEditor({
  slug,
  initialText,
  initialForm,
  initialParseError,
  baseVersion,
  initialFolder,
  folders,
}: EditorProps) {
  const isNew = slug === undefined;
  const navigate = useNavigate();
  const create = useCreateSubagent();
  const publish = usePublishSubagent(slug ?? '');

  const [mode, setMode] = useState<Mode>(initialParseError === undefined ? 'form' : 'raw');
  const [text, setText] = useState(initialText);
  const [form, setForm] = useState(initialForm);
  const [slugInput, setSlugInput] = useState('');
  const [folderInput, setFolderInput] = useState(initialFolder);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [switchError, setSwitchError] = useState<string | null>(
    initialParseError === undefined ? null : t.cannotSwitch(initialParseError),
  );
  const [slugError, setSlugError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const doneRef = useRef(false);
  const leaveDialog = useLeaveGuard({ dirty, doneRef });

  function editForm(patch: Partial<SubagentForm>) {
    const next = { ...form, ...patch };
    setForm(next);
    setText(serializeSubagentForm(next));
    setDirty(true);
  }

  function editRaw(next: string) {
    setText(next);
    setDirty(true);
  }

  function onSlugChange(next: string) {
    // The name follows the slug while it still equals it (an untouched template).
    if (mode === 'form' && form.name === slugInput) editForm({ name: next });
    else if (mode === 'raw' && text === serializeSubagentForm(emptySubagentForm(slugInput))) {
      editRaw(serializeSubagentForm(emptySubagentForm(next)));
    }
    setSlugInput(next);
    setSlugError(null);
    setDirty(true);
  }

  function changeMode(next: Mode) {
    if (next === mode) return;
    setSwitchError(null);
    if (next === 'form' && text !== serializeSubagentForm(form)) {
      const parsed = parseSubagentForm(text);
      if (!parsed.ok) return setSwitchError(t.cannotSwitch(parsed.error));
      setForm(parsed.value);
    }
    setMode(next);
  }

  async function submit() {
    if (isNew && !SLUG_RE.test(slugInput)) {
      return setSlugError(slugInput === '' ? t.slugRequired : t.slugInvalid);
    }
    if (isNew && folderInput === '') return setFolderError(t.folderRequired);
    setSaving(true);
    setSaveError(null);
    setFolderError(null);
    const note = message.trim() === '' ? {} : { message };
    try {
      const ref = isNew
        ? await create.mutateAsync({ slug: slugInput, folder: folderInput, content: text, ...note })
        : await publish.mutateAsync({ content: text, baseVersion: baseVersion ?? 1, ...note });
      doneRef.current = true;
      setDirty(false);
      notify.success(isNew ? t.created : t.published(ref.version));
      await navigate(subagentUrl(ref.slug));
    } catch (e) {
      if (isApiError(e) && e.status === 401) return; // AuthProvider redirects to the login page
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  const target = saveError === null ? null : classifyError(saveError, mode, isNew);
  const known = saveError === null ? null : errorText(saveError);
  const fieldMessage = known
    ? known.detail
      ? `${known.text}: ${known.detail}`
      : known.text
    : null;
  const blocked = mode === 'form' && toolsMissing(form.tools);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <h1 className="text-2xl font-semibold break-words">
        {isNew ? t.newTitle : t.editTitle(slug)}
      </h1>
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Tabs value={mode} onValueChange={(v) => changeMode(v === 'raw' ? 'raw' : 'form')}>
          <TabsList aria-label={t.tabs}>
            <TabsTrigger value="form">{t.form}</TabsTrigger>
            <TabsTrigger value="raw">{t.raw}</TabsTrigger>
          </TabsList>
        </Tabs>
        {switchError && (
          <p role="alert" className="text-sm text-destructive">
            {switchError}
          </p>
        )}

        {isNew && (
          <div className="flex max-w-md flex-col gap-2">
            <Label htmlFor="subagent-slug">{t.slug}</Label>
            <Input
              id="subagent-slug"
              value={slugInput}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={slugError !== null || undefined}
              aria-describedby="subagent-slug-hint"
              onChange={(e) => onSlugChange(e.target.value)}
            />
            <p id="subagent-slug-hint" className="text-sm text-muted-foreground">
              {t.slugHint}
            </p>
            {slugError && <FieldError id="subagent-slug-error">{slugError}</FieldError>}
            <Label>{t.folder}</Label>
            <FolderPicker
              folders={folders}
              value={folderInput}
              label={t.folder}
              onChange={(v) => {
                setFolderInput(v);
                setFolderError(null);
                setDirty(true);
              }}
            />
            {folderError && <FieldError id="subagent-folder-error">{folderError}</FieldError>}
            {target === 'folder' && fieldMessage && (
              <FieldError id="subagent-folder-server-error">{fieldMessage}</FieldError>
            )}
          </div>
        )}

        {mode === 'raw' ? (
          <CodeEditor value={text} onChange={editRaw} language="markdown" label={t.rawLabel} />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="subagent-description">{t.description}</Label>
              <Textarea
                id="subagent-description"
                value={form.description}
                maxLength={MAX_DESCRIPTION}
                aria-describedby="subagent-description-hint"
                onChange={(e) => editForm({ description: e.target.value })}
              />
              <p id="subagent-description-hint" className="text-sm text-muted-foreground">
                {t.descriptionHint}
              </p>
            </div>
            <div className="flex max-w-xs flex-col gap-2">
              <Label id="subagent-model-label">{t.model}</Label>
              <Select
                items={MODEL_ITEMS}
                value={form.model}
                onValueChange={(v) => {
                  const parsed = SubagentModel.safeParse(v);
                  if (parsed.success) editForm({ model: parsed.data });
                }}
              >
                <SelectTrigger aria-labelledby="subagent-model-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_ITEMS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ToolsField
              value={form.tools}
              onChange={(tools) => editForm({ tools })}
              error={target === 'tools' ? fieldMessage : null}
            />
            <SkillsField
              value={form.skills}
              onChange={(skills) => editForm({ skills })}
              error={target === 'skills' ? fieldMessage : null}
            />
            <div className="flex flex-col gap-2">
              <Label htmlFor="subagent-prompt">{t.prompt}</Label>
              <Textarea
                id="subagent-prompt"
                value={form.body}
                className="min-h-64 font-mono"
                onChange={(e) => editForm({ body: e.target.value })}
              />
            </div>
          </>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="subagent-message">{t.message}</Label>
          <Textarea
            id="subagent-message"
            value={message}
            maxLength={2000}
            placeholder={t.messagePlaceholder}
            onChange={(e) => {
              setMessage(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        {saveError !== null && target === 'top' && <ServerError error={saveError} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving || blocked}>
            {saving ? t.publishing : t.publish}
          </Button>
          <Link
            to={isNew ? '/subagents' : subagentUrl(slug)}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t.cancel}
          </Link>
        </div>
      </form>
      {leaveDialog}
    </div>
  );
}

/** `/subagents/:slug/edit`: starts from the current version. */
function EditSubagent({ slug }: { slug: string }) {
  const subagent = useSubagent(slug);
  const [start, setStart] = useState<SubagentView | null>(null);

  useEffect(() => {
    // Cached data may be stale (e.g. from the view page): wait for the refetch, or the first
    // publish would start from an old version and hit a spurious conflict.
    if (start || !subagent.data || subagent.isFetching) return;
    setStart(subagent.data);
  }, [start, subagent.data, subagent.isFetching]);

  if (subagent.isError) {
    if (isApiError(subagent.error) && subagent.error.code === 'subagent_not_found') {
      return (
        <EmptyState title={strings.subagent.notFound} description={strings.subagent.notFoundHint} />
      );
    }
    return <ErrorAlert error={subagent.error} />;
  }
  if (!start) return <PageSkeleton />;
  const parsed = parseSubagentForm(start.content);
  return (
    <SubagentEditor
      slug={slug}
      initialText={start.content}
      initialForm={parsed.ok ? parsed.value : emptySubagentForm(slug)}
      initialParseError={parsed.ok ? undefined : parsed.error}
      baseVersion={start.version}
      initialFolder={start.folder.slug}
      folders={[]}
    />
  );
}

/** `/subagents/new`. */
function NewSubagent() {
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
  const empty = emptySubagentForm();
  return (
    <SubagentEditor
      slug={undefined}
      initialText={serializeSubagentForm(empty)}
      initialForm={empty}
      baseVersion={undefined}
      initialFolder={folders.data.some((f) => f.slug === wanted) ? wanted : ''}
      folders={folders.data}
    />
  );
}

/** `/subagents/new` and `/subagents/:slug/edit`. */
export function SubagentEditorPage() {
  const { slug } = useParams();
  return slug === undefined ? <NewSubagent /> : <EditSubagent key={slug} slug={slug} />;
}
