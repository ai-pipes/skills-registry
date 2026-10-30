import { z } from 'zod';

export const FolderStatus = z.enum(['active', 'archived']);
export type FolderStatus = z.infer<typeof FolderStatus>;

export const FolderStatusFilter = z.enum(['active', 'archived', 'all']);
export type FolderStatusFilter = z.infer<typeof FolderStatusFilter>;

export const ListFoldersQuery = z.object({ status: FolderStatusFilter.default('active') });
export type ListFoldersQuery = z.infer<typeof ListFoldersQuery>;

export const FolderRef = z.object({ slug: z.string(), name: z.string() });
export type FolderRef = z.infer<typeof FolderRef>;

export const FolderSummary = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  status: FolderStatus,
  skills: z.object({ active: z.number().int(), archived: z.number().int() }),
});
export type FolderSummary = z.infer<typeof FolderSummary>;

export const CreateFolderRequest = z.object({
  slug: z.string().max(200),
  name: z.string().max(200),
  description: z.string().max(2000),
});
export type CreateFolderRequest = z.infer<typeof CreateFolderRequest>;

export const UpdateFolderRequest = z.object({
  name: z.string().max(200),
  description: z.string().max(2000),
});
export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequest>;

export const ArchiveFolderResponse = z.object({ archivedSkills: z.number().int() });
export type ArchiveFolderResponse = z.infer<typeof ArchiveFolderResponse>;
