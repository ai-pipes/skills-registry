import type { FolderSummary } from '@skills/contracts';
import { FolderIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { isApiError } from '@/api/errors.ts';
import { useCreateFolder, useFolders, useUpdateFolder } from '@/api/queries.ts';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { notify } from '@/lib/notify.ts';
import { strings } from '@/strings.ts';

const t = strings.folders;

// Same rule as the skill editor's slug.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface FieldErrors {
  slug?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {text}
    </p>
  );
}

function FolderForm({ folder }: { folder: FolderSummary | undefined }) {
  const isNew = folder === undefined;
  const navigate = useNavigate();
  const create = useCreateFolder();
  const update = useUpdateFolder(folder?.slug ?? '');
  const mutation = isNew ? create : update;
  const baseId = useId();
  const [slug, setSlug] = useState(folder?.slug ?? '');
  const [name, setName] = useState(folder?.name ?? '');
  const [description, setDescription] = useState(folder?.description ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});

  // Server errors that belong to a field (slug) or to the form as a whole.
  const serverCode = mutation.error && isApiError(mutation.error) ? mutation.error.code : null;
  const serverSlugError =
    serverCode === 'folder_exists' || serverCode === 'invalid_slug'
      ? t.serverErrors[serverCode]
      : undefined;
  const serverFormError = mutation.isError && serverSlugError === undefined;
  const slugError = errors.slug ?? serverSlugError;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    if (isNew) {
      if (!SLUG_RE.test(slug)) next.slug = slug === '' ? t.slugRequired : t.slugInvalid;
    }
    if (name.trim() === '') next.name = t.nameRequired;
    if (description.trim() === '') next.description = t.descriptionRequired;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      if (isNew) {
        await create.mutateAsync({
          slug,
          name: name.trim(),
          description: description.trim(),
        });
      } else {
        await update.mutateAsync({ name: name.trim(), description: description.trim() });
      }
    } catch {
      return; // shown under the field / the form
    }
    notify.success(isNew ? t.created : t.saved);
    void navigate('/folders');
  }

  const slugId = `${baseId}-slug`;
  const nameId = `${baseId}-name`;
  const descriptionId = `${baseId}-description`;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{isNew ? t.newTitle : t.editTitle(folder.slug)}</h1>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={slugId}>{t.slug}</Label>
          <Input
            id={slugId}
            value={slug}
            readOnly={!isNew}
            maxLength={64}
            aria-invalid={slugError ? true : undefined}
            aria-describedby={`${slugId}-hint${slugError ? ` ${slugId}-error` : ''}`}
            onChange={(e) => {
              setSlug(e.target.value);
              setErrors((prev) => ({ ...prev, slug: undefined }));
              if (mutation.isError) mutation.reset();
            }}
          />
          <p id={`${slugId}-hint`} className="text-sm text-muted-foreground">
            {t.slugHint}
          </p>
          <FieldError id={`${slugId}-error`} text={slugError} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>{t.name}</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={100}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${nameId}-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((prev) => ({ ...prev, name: undefined }));
            }}
          />
          <FieldError id={`${nameId}-error`} text={errors.name} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={descriptionId}>{t.description}</Label>
          <Textarea
            id={descriptionId}
            value={description}
            maxLength={1000}
            rows={4}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={`${descriptionId}-hint${errors.description ? ` ${descriptionId}-error` : ''}`}
            onChange={(e) => {
              setDescription(e.target.value);
              setErrors((prev) => ({ ...prev, description: undefined }));
            }}
          />
          <p id={`${descriptionId}-hint`} className="text-sm text-muted-foreground">
            {t.descriptionHint}
          </p>
          <FieldError id={`${descriptionId}-error`} text={errors.description} />
        </div>
        {serverFormError && (
          <ErrorAlert
            error={mutation.error}
            message={serverCode ? t.serverErrors[serverCode] : undefined}
          />
        )}
        <div className="flex justify-end gap-2">
          <Link to="/folders" className={buttonVariants({ variant: 'outline' })}>
            {t.cancel}
          </Link>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? t.submitting : t.submit}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** `/folders/new` and `/folders/:slug/edit`. */
export function FolderFormPage() {
  const { slug } = useParams();
  const folders = useFolders('all');
  if (slug === undefined) return <FolderForm folder={undefined} />;
  if (folders.isError) return <ErrorAlert error={folders.error} />;
  if (folders.data === undefined) return <Skeleton className="h-32 w-full" />;
  const folder = folders.data.find((f) => f.slug === slug);
  if (folder === undefined) {
    return (
      <EmptyState
        icon={FolderIcon}
        title={t.notFound}
        action={
          <Link to="/folders" className={buttonVariants({ variant: 'outline' })}>
            {t.title}
          </Link>
        }
      />
    );
  }
  return <FolderForm key={folder.slug} folder={folder} />;
}
