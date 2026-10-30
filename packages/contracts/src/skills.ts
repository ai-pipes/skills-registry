import { z } from 'zod';
import { FolderRef } from './folders.ts';

const versionNumber = z.coerce.number().int().min(1).max(2_147_483_647);
const message = z.string().max(2000);

export const SkillStatusFilter = z.enum(['active', 'archived', 'all']);
export type SkillStatusFilter = z.infer<typeof SkillStatusFilter>;

export const ListSkillsQuery = z.object({
  status: SkillStatusFilter.default('active'),
  q: z.string().max(500).optional(),
  folder: z.string().max(200).optional(),
});
export type ListSkillsQuery = z.infer<typeof ListSkillsQuery>;

export const VersionQuery = z.object({ version: versionNumber.optional() });
export type VersionQuery = z.infer<typeof VersionQuery>;

export const DiffQuery = z.object({ from: versionNumber, to: versionNumber });
export type DiffQuery = z.infer<typeof DiffQuery>;

/**
 * Text fields of the `POST /api/skills` multipart body; every file part's field name is its path.
 * A skill imported from GitHub carries its source: `sourceHost`, `sourceRepo`, `sourcePath` (may be
 * `''` for a skill at the repository root) and `sourceCommit` all together, `sourceRef` only with them.
 */
export const CreateSkillFields = z
  .object({
    slug: z.string().max(200),
    folder: z.string().max(200),
    message: message.optional(),
    sourceHost: z.string().optional(),
    sourceRepo: z.string().optional(),
    sourcePath: z.string().optional(),
    sourceRef: z.string().optional(),
    sourceCommit: z.string().optional(),
  })
  .refine(
    (f) => {
      const set = [f.sourceHost, f.sourceRepo, f.sourcePath, f.sourceCommit].filter(
        (v) => v !== undefined,
      ).length;
      if (set === 0) return f.sourceRef === undefined;
      return set === 4;
    },
    { message: 'source fields must be given all together', path: ['sourceRepo'] },
  );
export type CreateSkillFields = z.infer<typeof CreateSkillFields>;

/**
 * Text fields of the `PUT /api/skills/:slug` multipart body. The new version is the file parts
 * plus the base version's files named in `keep` (a JSON array of paths, at most 500).
 */
export const PublishVersionFields = z.object({
  baseVersion: versionNumber,
  message: message.optional(),
  keep: z.string().default('[]'),
  /** The upstream commit this version was taken from; only for a skill imported from GitHub. */
  sourceCommit: z.string().optional(),
});
export type PublishVersionFields = z.infer<typeof PublishVersionFields>;

export const RollbackRequest = z.object({
  toVersion: z.number().int().min(1),
  baseVersion: z.number().int().min(1),
});
export type RollbackRequest = z.infer<typeof RollbackRequest>;

export const SkillStatus = z.enum(['active', 'archived']);
export type SkillStatus = z.infer<typeof SkillStatus>;

export const SkillSummary = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  status: SkillStatus,
  folder: FolderRef,
  version: z.number(),
  updatedAt: z.iso.datetime(),
});
export type SkillSummary = z.infer<typeof SkillSummary>;

/** Where an imported skill came from; `syncedVersion` is the last version taken from upstream. */
export const SkillSource = z.object({
  host: z.string(),
  repo: z.string(),
  path: z.string(),
  ref: z.string().nullable(),
  syncedVersion: z.number(),
});
export type SkillSource = z.infer<typeof SkillSource>;

export const SkillView = SkillSummary.extend({
  skillMd: z.string(),
  skillMdSha256: z.string(),
  files: z.array(
    z.object({ path: z.string(), size: z.number(), binary: z.boolean(), sha256: z.string() }),
  ),
  source: SkillSource.nullable(),
  /** The upstream commit of the shown version; null when it was not taken from upstream. */
  sourceCommit: z.string().nullable(),
});
export type SkillView = z.infer<typeof SkillView>;

export const VersionSummary = z.object({
  number: z.number(),
  authorId: z.string(),
  /** Null when the author is unknown (e.g. the user no longer exists). */
  authorLogin: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.iso.datetime(),
  restoredFrom: z.number().nullable(),
  sourceCommit: z.string().nullable(),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const FileDiff = z.object({
  path: z.string(),
  status: z.enum(['added', 'removed', 'modified', 'unchanged']),
  patch: z.string().nullable(),
  tooLarge: z.literal(true).optional(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const VersionRef = z.object({ slug: z.string(), version: z.number() });
export type VersionRef = z.infer<typeof VersionRef>;

export const MoveSkillRequest = z.object({ folder: z.string().max(200) });
export type MoveSkillRequest = z.infer<typeof MoveSkillRequest>;

export const RestoreSkillRequest = z.object({ folder: z.string().max(200).optional() });
export type RestoreSkillRequest = z.infer<typeof RestoreSkillRequest>;
