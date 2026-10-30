// Resolve options for dependency-cruiser (`options.webpackConfig` in .dependency-cruiser.cjs).
// Not a webpack build: it only teaches the cruiser the web app's `@/` alias. tsconfig `paths`
// cannot be used for that, because tsconfig-paths needs `baseUrl`, which TypeScript 7 removed.
// Keep in sync with `resolve.alias` in apps/web/vite.config.ts and `paths` in apps/web/tsconfig.json.
const path = require('node:path');

module.exports = {
  resolve: { alias: { '@': path.join(__dirname, 'apps/web/src') } },
};
