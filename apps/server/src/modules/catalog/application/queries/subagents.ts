import { createTwoFilesPatch } from 'diff';
import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import type { ContentHash } from '../../domain/content-hash.ts';
import { CatalogError } from '../../domain/errors.ts';
import type { CatalogDeps } from '../deps.ts';
import type { SubagentListFilter, SubagentSummary } from '../ports.ts';
import { loadSubagent, loadSubagentVersion } from './load.ts';

export type { SubagentSummary } from '../ports.ts';

/** The summary fields (version, name, description, model, tools, skills) are the shown version's. */
export type SubagentView = SubagentSummary & { content: string };

export type SubagentVersionSummary = {
  number: number;
  authorId: string;
  message: string | null;
  createdAt: Date;
  restoredFrom: number | null;
};

export type SubagentDiff = {
  /** Unified diff of the two SUBAGENT.md texts; null when they are equal. */
  patch: string | null;
  tools: { from: string[] | null; to: string[] | null };
};

const DIFF_TIMEOUT_MS = 1000;
const DIFF_MAX_EDIT_LENGTH = 10_000;

async function readContent(blobs: CatalogDeps['blobs'], hash: ContentHash): Promise<string> {
  const bytes = await blobs.get(hash);
  if (!bytes) throw new Error(`blob ${hash.value} is missing`);
  return new TextDecoder().decode(bytes);
}

const copy = (tools: readonly string[] | null) => (tools === null ? null : [...tools]);

export async function getSubagent(
  deps: Pick<CatalogDeps, 'subagents' | 'blobs' | 'folders'>,
  q: { slug: string; version?: number },
): Promise<Result<SubagentView, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, q.slug);
  if (!subagent.ok) return subagent;
  const version = await loadSubagentVersion(deps.subagents, subagent.value, q.version);
  if (!version.ok) return version;
  const v = version.value;
  const folder = await deps.folders.findById(subagent.value.folderId);
  if (!folder) {
    throw new Error(`folder ${subagent.value.folderId} of subagent "${q.slug}" is missing`);
  }
  return ok({
    slug: subagent.value.slug.value,
    name: v.name,
    description: v.description,
    status: subagent.value.status,
    version: v.number,
    updatedAt: subagent.value.updatedAt,
    folder: { slug: folder.slug.value, name: folder.name },
    model: v.model,
    tools: copy(v.tools),
    skills: [...v.skills],
    content: await readContent(deps.blobs, v.contentHash),
  });
}

/** `folder` is a folder slug; an unknown one lists nothing. */
export async function listSubagents(
  deps: Pick<CatalogDeps, 'subagents'>,
  q: { status: SubagentListFilter['status']; folder?: string },
): Promise<SubagentSummary[]> {
  return deps.subagents.listSummaries({ status: q.status, folder: q.folder ?? null });
}

export async function getSubagentHistory(
  deps: Pick<CatalogDeps, 'subagents'>,
  q: { slug: string },
): Promise<Result<SubagentVersionSummary[], CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, q.slug);
  if (!subagent.ok) return subagent;
  const versions = await deps.subagents.listVersions(subagent.value.id);
  return ok(
    versions
      .map((v) => ({
        number: v.number,
        authorId: v.authorId,
        message: v.message,
        createdAt: v.createdAt,
        restoredFrom: v.restoredFrom,
      }))
      .toSorted((a, b) => b.number - a.number),
  );
}

export async function diffSubagentVersions(
  deps: Pick<CatalogDeps, 'subagents' | 'blobs'>,
  q: { slug: string; from: number; to: number },
): Promise<Result<SubagentDiff, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, q.slug);
  if (!subagent.ok) return subagent;
  const [from, to] = await Promise.all([
    deps.subagents.getVersion(subagent.value.id, q.from),
    deps.subagents.getVersion(subagent.value.id, q.to),
  ]);
  if (!from || !to) {
    return err(new CatalogError('version_not_found', `version ${from ? q.to : q.from} not found`));
  }
  const tools = { from: copy(from.tools), to: copy(to.tools) };
  if (from.contentHash.equals(to.contentHash)) return ok({ patch: null, tools });
  const [before, after] = await Promise.all([
    readContent(deps.blobs, from.contentHash),
    readContent(deps.blobs, to.contentHash),
  ]);
  const patch = createTwoFilesPatch(
    'SUBAGENT.md',
    'SUBAGENT.md',
    before,
    after,
    undefined,
    undefined,
    {
      timeout: DIFF_TIMEOUT_MS,
      maxEditLength: DIFF_MAX_EDIT_LENGTH,
    },
  );
  return ok({ patch: patch ?? null, tools });
}
