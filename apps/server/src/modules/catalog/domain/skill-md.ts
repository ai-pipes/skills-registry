import { parse, YAMLError } from 'yaml';
import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
};

const MAX_DESCRIPTION = 1024;
const FRONTMATTER_RE = /^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/;

const invalid = (message: string) => err(new CatalogError('invalid_frontmatter', message));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** ` (line N, column M)` in SKILL.md (the frontmatter starts on line 2), or `''`. */
function yamlPosition(cause: unknown): string {
  const at = cause instanceof YAMLError ? cause.linePos?.[0] : undefined;
  return at ? ` (line ${at.line + 1}, column ${at.col})` : '';
}

export function parseSkillMd(text: string): Result<ParsedSkillMd, CatalogError> {
  const normalized = text.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) return invalid('SKILL.md must start with a frontmatter block delimited by ---');

  let data: unknown;
  try {
    data = parse(match[1] ?? '');
  } catch (cause) {
    // yaml's own message quotes the offending lines; the error goes to the client and to logs,
    // which never carry skill content, so only the position is kept.
    return invalid(`frontmatter is not valid YAML${yamlPosition(cause)}`);
  }
  if (!isRecord(data)) return invalid('frontmatter must be a YAML mapping');
  const frontmatter = data;
  const { name, description } = frontmatter;
  if (!nonEmptyString(name)) return invalid('frontmatter "name" must be a non-empty string');
  if (!nonEmptyString(description)) {
    return invalid('frontmatter "description" must be a non-empty string');
  }
  if (description.length > MAX_DESCRIPTION) {
    return invalid(`frontmatter "description" exceeds ${MAX_DESCRIPTION} characters`);
  }
  return ok({ name, description, body: match[2] ?? '', frontmatter });
}
