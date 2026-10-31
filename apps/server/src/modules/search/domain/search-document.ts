/** Longest text handed to the embedder (plan): keeps one embedding call well inside the outbox lease. */
export const MAX_PASSAGE_CHARS = 2000;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** SKILL.md or SUBAGENT.md without its YAML frontmatter, trimmed. */
export function documentBody(markdown: string): string {
  return markdown.replace(FRONTMATTER, '').trim();
}

/** Embedding passage: name, description and body, truncated to MAX_PASSAGE_CHARS. */
export function buildPassage(doc: { name: string; description: string; body: string }): string {
  return `${doc.name}\n${doc.description}\n${doc.body}`.slice(0, MAX_PASSAGE_CHARS);
}
