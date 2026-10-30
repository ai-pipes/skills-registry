/** Longest text handed to the embedder (plan): keeps one embedding call well inside the outbox lease. */
export const MAX_PASSAGE_CHARS = 2000;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** SKILL.md without its YAML frontmatter, trimmed. */
export function skillBody(skillMd: string): string {
  return skillMd.replace(FRONTMATTER, '').trim();
}

/** Embedding passage: name, description and body, truncated to MAX_PASSAGE_CHARS. */
export function buildPassage(view: { name: string; description: string; skillMd: string }): string {
  return `${view.name}\n${view.description}\n${skillBody(view.skillMd)}`.slice(
    0,
    MAX_PASSAGE_CHARS,
  );
}
