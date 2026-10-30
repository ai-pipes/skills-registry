// Fails when pnpm-lock.yaml contains Radix packages (`radix-ui`, `@radix-ui/*`), even as a
// transitive dependency. The UI kit is shadcn/ui on Base UI; the dependency-cruiser rule
// `no-radix` covers imports, this covers the lockfile. Runs in `pnpm arch` (and so in CI).
import { readFileSync } from 'node:fs';

const RADIX = /(?:^|[\s'"])(?:@radix-ui\/[\w.-]+|radix-ui)[@:'"]/;

const hits = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  .split('\n')
  .flatMap((line, i) => (RADIX.test(line) ? [`  pnpm-lock.yaml:${i + 1}: ${line.trim()}`] : []));

if (hits.length > 0) {
  console.error(`Radix packages are not allowed (shadcn/ui on Base UI only):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('no Radix packages in pnpm-lock.yaml');
