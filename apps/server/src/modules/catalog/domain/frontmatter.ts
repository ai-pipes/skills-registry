import { parse, YAMLError } from 'yaml';
import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';

const FRONTMATTER_RE = /^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/;

const invalid = (message: string) => err(new CatalogError('invalid_frontmatter', message));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** ` (line N, column M)` in the file (the frontmatter starts on line 2), or `''`. */
function yamlPosition(cause: unknown): string {
  const at = cause instanceof YAMLError ? cause.linePos?.[0] : undefined;
  return at ? ` (line ${at.line + 1}, column ${at.col})` : '';
}

/** Splits a `---` frontmatter block off a markdown file (BOM and CRLF are normalised). */
export function splitFrontmatter(
  text: string,
  fileName: 'SKILL.md' | 'SUBAGENT.md',
): Result<{ data: Record<string, unknown>; body: string }, CatalogError> {
  const normalized = text.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) return invalid(`${fileName} must start with a frontmatter block delimited by ---`);

  let data: unknown;
  try {
    data = parse(match[1] ?? '');
  } catch (cause) {
    // yaml's own message quotes the offending lines; the error goes to the client and to logs,
    // which never carry file content, so only the position is kept.
    return invalid(`frontmatter is not valid YAML${yamlPosition(cause)}`);
  }
  if (!isRecord(data)) return invalid('frontmatter must be a YAML mapping');
  return ok({ data, body: match[2] ?? '' });
}
