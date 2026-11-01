import { ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from './errors.ts';
import { parseNameAndDescription, splitFrontmatter } from './frontmatter.ts';

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
};

export function parseSkillMd(text: string): Result<ParsedSkillMd, CatalogError> {
  const split = splitFrontmatter(text, 'SKILL.md');
  if (!split.ok) return split;
  const { data: frontmatter, body } = split.value;
  const nd = parseNameAndDescription(frontmatter);
  if (!nd.ok) return nd;
  const { name, description } = nd.value;
  return ok({ name, description, body, frontmatter });
}
