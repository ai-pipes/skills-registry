// Claude Code PostToolUse hook: runs `vp check` on the edited .ts/.tsx file.
// Reads the hook payload from stdin, prints diagnostics, ALWAYS exits 0 (non-blocking).
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const payload = JSON.parse(await readStdin());
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath === 'string' && /\.tsx?$/.test(filePath)) {
    const rel = relative(repoRoot, resolve(repoRoot, filePath));
    const inside =
      rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
    if (inside) {
      const res = spawnSync('pnpm', ['-s', 'vp', 'check', rel], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      if (out) console.log(out);
    }
  }
} catch (error) {
  console.log(`claude-post-edit: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
