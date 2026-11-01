import { z } from 'zod';
import { FolderRef } from './folders.ts';
import { SkillStatus, SkillStatusFilter, VersionSummary } from './skills.ts';

export const SubagentModel = z.enum(['inherit', 'sonnet', 'opus', 'haiku']);
export type SubagentModel = z.infer<typeof SubagentModel>;

/** A built-in tool name, e.g. `Read`; the other accepted form is an MCP tool. */
export const BUILTIN_TOOL_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** An MCP tool name, `mcp__<server>__<tool>`. */
export const MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

/** Limit on the whole `SUBAGENT.md`: the request schema counts characters, the server checks UTF-8 bytes. */
export const MAX_SUBAGENT_MD_BYTES = 65_536;

const message = z.string().max(2000);
const content = z.string().max(MAX_SUBAGENT_MD_BYTES);

export const ListSubagentsQuery = z.object({
  status: SkillStatusFilter.default('active'),
  q: z.string().max(500).optional(),
  folder: z.string().max(200).optional(),
});
export type ListSubagentsQuery = z.infer<typeof ListSubagentsQuery>;

export const CreateSubagentRequest = z.object({
  slug: z.string().max(200),
  folder: z.string().max(200),
  content,
  message: message.optional(),
});
export type CreateSubagentRequest = z.infer<typeof CreateSubagentRequest>;

export const PublishSubagentRequest = z.object({
  content,
  baseVersion: z.number().int().min(1),
  message: message.optional(),
});
export type PublishSubagentRequest = z.infer<typeof PublishSubagentRequest>;

export const SubagentSummary = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  status: SkillStatus,
  folder: FolderRef,
  version: z.number(),
  updatedAt: z.iso.datetime(),
  model: SubagentModel,
  /** Null when `tools` is omitted: the subagent inherits all tools. */
  tools: z.array(z.string()).nullable(),
  skills: z.array(z.string()),
});
export type SubagentSummary = z.infer<typeof SubagentSummary>;

export const SubagentView = SubagentSummary.extend({ content: z.string() });
export type SubagentView = z.infer<typeof SubagentView>;

export const SubagentVersionSummary = VersionSummary.omit({ sourceCommit: true });
export type SubagentVersionSummary = z.infer<typeof SubagentVersionSummary>;

const ToolList = z.array(z.string()).nullable();

export const SubagentDiff = z.object({
  patch: z.string().nullable(),
  tools: z.object({ from: ToolList, to: ToolList }),
});
export type SubagentDiff = z.infer<typeof SubagentDiff>;
