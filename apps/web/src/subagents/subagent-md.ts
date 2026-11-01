import {
  BUILTIN_TOOL_PATTERN,
  MAX_SUBAGENT_MD_BYTES,
  MCP_TOOL_PATTERN,
  SubagentModel,
} from '@skills/contracts';
import { parse, stringify, YAMLError } from 'yaml';

/** The fields of a `SUBAGENT.md` the form edits; `tools: null` means "inherit all tools". */
export type SubagentForm = {
  name: string;
  description: string;
  model: SubagentModel;
  tools: string[] | null;
  skills: string[];
  body: string;
};

export type ParsedSubagentForm = { ok: true; value: SubagentForm } | { ok: false; error: string };

const MAX_DESCRIPTION = 1024;
const MAX_SKILLS = 20;
const KNOWN_KEYS = new Set(['name', 'description', 'tools', 'model', 'skills']);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The same split as the server's (`catalog/domain/frontmatter.ts`).
const FRONTMATTER_RE = /^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const fail = (error: string): ParsedSubagentForm => ({ ok: false, error });

function stringList(v: unknown, field: string): string[] | string {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    return `frontmatter "${field}" must be a list of strings`;
  }
  if (new Set(v).size !== v.length) return `frontmatter "${field}" has duplicates`;
  return v;
}

/** An empty form for a new subagent named `name`. */
export function emptySubagentForm(name = ''): SubagentForm {
  return { name, description: '', model: 'inherit', tools: null, skills: [], body: '' };
}

/** `SUBAGENT.md` text of a form: the frontmatter is YAML-quoted as needed, the body is verbatim. */
export function serializeSubagentForm(form: SubagentForm): string {
  const meta: Record<string, unknown> = { name: form.name, description: form.description };
  if (form.tools !== null) meta['tools'] = form.tools;
  if (form.model !== 'inherit') meta['model'] = form.model;
  if (form.skills.length > 0) meta['skills'] = form.skills;
  return `---\n${stringify(meta, { lineWidth: 0 })}---\n${form.body}`;
}

/**
 * Client-side check of the SUBAGENT.md rules (spec §6), used to switch from Raw to Form. The
 * server stays authoritative; the messages follow its wording.
 */
export function parseSubagentForm(text: string): ParsedSubagentForm {
  if (new TextEncoder().encode(text).length > MAX_SUBAGENT_MD_BYTES) {
    return fail(`SUBAGENT.md exceeds ${MAX_SUBAGENT_MD_BYTES} bytes`);
  }
  const normalized = text.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) return fail('SUBAGENT.md must start with a frontmatter block delimited by ---');

  let data: unknown;
  try {
    data = parse(match[1] ?? '');
  } catch (cause) {
    const at = cause instanceof YAMLError ? cause.linePos?.[0] : undefined;
    return fail(`frontmatter is not valid YAML${at ? ` (line ${at.line + 1})` : ''}`);
  }
  if (!isRecord(data)) return fail('frontmatter must be a YAML mapping');
  const meta = data;

  const unknown = Object.keys(meta).find((k) => !KNOWN_KEYS.has(k));
  if (unknown !== undefined) return fail(`unknown frontmatter key "${unknown}"`);

  const { name, description } = meta;
  if (typeof name !== 'string' || name.trim() === '') {
    return fail('frontmatter "name" must be a non-empty string');
  }
  if (typeof description !== 'string' || description.trim() === '') {
    return fail('frontmatter "description" must be a non-empty string');
  }
  if (description.length > MAX_DESCRIPTION) {
    return fail(`frontmatter "description" exceeds ${MAX_DESCRIPTION} characters`);
  }

  let tools: string[] | null = null;
  if (meta['tools'] !== undefined) {
    const list = stringList(meta['tools'], 'tools');
    if (typeof list === 'string') return fail(list);
    if (list.length === 0) return fail('frontmatter "tools" must not be empty');
    const bad = list.find((t) => !BUILTIN_TOOL_PATTERN.test(t) && !MCP_TOOL_PATTERN.test(t));
    if (bad !== undefined) return fail(`frontmatter "tools" has an invalid tool name "${bad}"`);
    tools = list;
  }

  let model: SubagentModel = 'inherit';
  if (meta['model'] !== undefined) {
    const parsed = SubagentModel.safeParse(meta['model']);
    if (!parsed.success) {
      return fail(`frontmatter "model" must be one of ${SubagentModel.options.join(', ')}`);
    }
    model = parsed.data;
  }

  let skills: string[] = [];
  if (meta['skills'] !== undefined) {
    const list = stringList(meta['skills'], 'skills');
    if (typeof list === 'string') return fail(list);
    if (list.length > MAX_SKILLS) {
      return fail(`frontmatter "skills" has more than ${MAX_SKILLS} entries`);
    }
    const bad = list.find((s) => !SLUG_RE.test(s));
    if (bad !== undefined) return fail(`frontmatter "skills" has an invalid slug "${bad}"`);
    skills = list;
  }

  return { ok: true, value: { name, description, model, tools, skills, body: match[2] ?? '' } };
}
