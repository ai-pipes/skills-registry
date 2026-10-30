export interface PatchLine {
  kind: 'add' | 'del' | 'ctx';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface PatchHunk {
  header: string;
  lines: PatchLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff (`createTwoFilesPatch`). File headers (`Index:`, `===`, `---`, `+++`)
 * before the first hunk and `\ No newline at end of file` markers are skipped.
 */
export function parsePatch(patch: string): { hunks: PatchHunk[] } {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const rows = patch.split('\n');
  if (rows.at(-1) === '') rows.pop();
  for (const raw of rows) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null || line.startsWith('\\')) continue;
    const text = line.slice(1);
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', oldNo: null, newNo, text });
      newNo += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', oldNo, newNo: null, text });
      oldNo += 1;
    } else {
      current.lines.push({ kind: 'ctx', oldNo, newNo, text });
      oldNo += 1;
      newNo += 1;
    }
  }
  return { hunks };
}
