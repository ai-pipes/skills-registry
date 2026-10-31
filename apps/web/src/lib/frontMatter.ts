/** The YAML front matter is metadata (shown in the header), not part of the rendered text. */
export function withoutFrontMatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
}
