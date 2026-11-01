import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';
import { parseNameAndDescription, splitFrontmatter } from './frontmatter.ts';
import { Slug } from './slug.ts';

export type SubagentModel = 'inherit' | 'sonnet' | 'opus' | 'haiku';

export type ParsedSubagentMd = {
  name: string;
  description: string;
  /** null: inherit every tool. */
  tools: string[] | null;
  model: SubagentModel;
  skills: string[];
  body: string;
};

export const MAX_SUBAGENT_MD_BYTES = 65_536;
export const MAX_SUBAGENT_SKILLS = 20;

const MODELS: readonly SubagentModel[] = ['inherit', 'sonnet', 'opus', 'haiku'];
const isModel = (v: unknown): v is SubagentModel => MODELS.some((m) => m === v);
const KNOWN_KEYS = new Set(['name', 'description', 'tools', 'model', 'skills']);
const BUILTIN_TOOL_RE = /^[A-Z][A-Za-z0-9]*$/;
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

const invalid = (message: string) => err(new CatalogError('invalid_frontmatter', message));

/** A list of strings without duplicates; `field` names it in the error. */
function stringList(v: unknown, field: string): Result<string[], CatalogError> {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    return invalid(`frontmatter "${field}" must be a list of strings`);
  }
  if (new Set(v).size !== v.length) return invalid(`frontmatter "${field}" has duplicates`);
  return ok(v);
}

export function parseSubagentMd(text: string): Result<ParsedSubagentMd, CatalogError> {
  if (new TextEncoder().encode(text).length > MAX_SUBAGENT_MD_BYTES) {
    return err(
      new CatalogError('limit_exceeded', `SUBAGENT.md exceeds ${MAX_SUBAGENT_MD_BYTES} bytes`),
    );
  }
  const split = splitFrontmatter(text, 'SUBAGENT.md');
  if (!split.ok) return split;
  const { data, body } = split.value;

  const unknown = Object.keys(data).find((k) => !KNOWN_KEYS.has(k));
  if (unknown !== undefined) return invalid(`unknown frontmatter key "${unknown}"`);

  const nd = parseNameAndDescription(data);
  if (!nd.ok) return nd;
  const { name, description } = nd.value;

  let tools: string[] | null = null;
  if (data.tools !== undefined) {
    const list = stringList(data.tools, 'tools');
    if (!list.ok) return list;
    if (list.value.length === 0) return invalid('frontmatter "tools" must not be empty');
    const bad = list.value.find((t) => !BUILTIN_TOOL_RE.test(t) && !MCP_TOOL_RE.test(t));
    if (bad !== undefined) return invalid(`frontmatter "tools" has an invalid tool name "${bad}"`);
    tools = list.value;
  }

  let model: SubagentModel = 'inherit';
  if (data.model !== undefined) {
    if (!isModel(data.model)) {
      return invalid(`frontmatter "model" must be one of ${MODELS.join(', ')}`);
    }
    model = data.model;
  }

  let skills: string[] = [];
  if (data.skills !== undefined) {
    const list = stringList(data.skills, 'skills');
    if (!list.ok) return list;
    if (list.value.length > MAX_SUBAGENT_SKILLS) {
      return invalid(`frontmatter "skills" has more than ${MAX_SUBAGENT_SKILLS} entries`);
    }
    const bad = list.value.find((s) => !Slug.parse(s).ok);
    if (bad !== undefined) return invalid(`frontmatter "skills" has an invalid slug "${bad}"`);
    skills = list.value;
  }

  return ok({ name, description, tools, model, skills, body });
}
