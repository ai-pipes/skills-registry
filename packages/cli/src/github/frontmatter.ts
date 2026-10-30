import { parse } from 'yaml';

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** `name` and `description` of a SKILL.md's YAML frontmatter; `null` if either is missing. */
export function parseFrontmatter(md: string): { name: string; description: string } | null {
  const m = FRONTMATTER.exec(md);
  if (!m) return null;
  let data: unknown;
  try {
    data = parse(m[1] ?? '');
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const name = 'name' in data ? data.name : undefined;
  const description = 'description' in data ? data.description : undefined;
  if (typeof name !== 'string' || name === '' || typeof description !== 'string') return null;
  return { name, description };
}
