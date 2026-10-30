import { defineConfig } from 'vite-plus';

// CLI bundle (`pnpm build:cli`): dist/cli.js with a node shebang (from src/main.ts). npm
// dependencies stay external (installed with the package); the workspace contracts package is
// TypeScript source, so it is bundled in and never published on its own.
export default defineConfig({
  pack: {
    entry: { cli: 'src/main.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    deps: {
      neverBundle: [/^zod(?:\/|$)/, /^yaml(?:\/|$)/],
      alwaysBundle: ['@skills/contracts'],
    },
  },
});
