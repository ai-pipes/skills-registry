import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';
import { splitFrontmatter } from './frontmatter.ts';

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
};

const MAX_DESCRIPTION = 1024;
const invalid = (message: string) => err(new CatalogError('invalid_frontmatter', message));

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function parseSkillMd(text: string): Result<ParsedSkillMd, CatalogError> {
  const split = splitFrontmatter(text, 'SKILL.md');
  if (!split.ok) return split;
  const { data: frontmatter, body } = split.value;
  const { name, description } = frontmatter;
  if (!nonEmptyString(name)) return invalid('frontmatter "name" must be a non-empty string');
  if (!nonEmptyString(description)) {
    return invalid('frontmatter "description" must be a non-empty string');
  }
  if (description.length > MAX_DESCRIPTION) {
    return invalid(`frontmatter "description" exceeds ${MAX_DESCRIPTION} characters`);
  }
  return ok({ name, description, body, frontmatter });
}
