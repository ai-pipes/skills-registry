/**
 * Architecture rules (spec §8.3). `$1` in a `to` condition refers to the first
 * capture group of the `from.path` — the module name.
 * The rules deliberately overlap (e.g. domain -> infrastructure breaks both
 * `domain-is-pure` and `no-inward-infra`): each one documents a separate invariant.
 */
// Unit tests live next to the code and import the test runner (vite-plus/test).
const TEST_FILE = '\\.test\\.ts$';
const MODULE = '(?:^|/)modules/([^/]+)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment:
        'domain may import only its own domain/, shared-kernel/ and the npm package `yaml` (frontmatter parsing).',
      severity: 'error',
      from: { path: `${MODULE}domain/`, pathNot: TEST_FILE },
      to: {
        pathNot: [
          `(?:^|/)modules/$1/domain/`,
          '(?:^|/)shared-kernel/',
          '(?:^|/)node_modules/yaml/',
        ],
      },
    },
    {
      name: 'application-only-domain',
      comment:
        "application may import its module's domain/ and application/, shared-kernel/, other modules' public index.ts, and npm `zod`, `diff`.",
      severity: 'error',
      from: { path: `${MODULE}application/`, pathNot: TEST_FILE },
      to: {
        pathNot: [
          `(?:^|/)modules/$1/(?:domain|application)/`,
          '(?:^|/)shared-kernel/',
          '(?:^|/)modules/[^/]+/index\\.ts$',
          '(?:^|/)node_modules/(?:zod|diff)/',
        ],
      },
    },
    {
      name: 'no-inward-infra',
      comment: 'domain and application must not import infrastructure, interfaces or platform.',
      severity: 'error',
      from: { path: '(?:^|/)modules/[^/]+/(?:domain|application)/' },
      to: { path: '(?:^|/)(?:modules/[^/]+/(?:infrastructure|interfaces)|platform)/' },
    },
    {
      name: 'modules-via-index',
      comment: "modules talk to each other only through the other module's public index.ts.",
      severity: 'error',
      from: { path: MODULE },
      to: {
        path: '(?:^|/)modules/[^/]+/',
        pathNot: [`(?:^|/)modules/$1/`, '(?:^|/)modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'no-radix',
      comment:
        'the UI kit is shadcn/ui on Base UI; Radix packages (`radix-ui`, `@radix-ui/*`) are not used anywhere.',
      severity: 'error',
      from: {},
      to: { path: '(?:^|/)(?:radix-ui|@radix-ui/[^/]+)(?:/|$)' },
    },
    {
      name: 'web-no-server',
      comment:
        'the web SPA talks to the server over HTTP only; it shares types via @skills/contracts.',
      severity: 'error',
      from: { path: '(?:^|/)apps/web/' },
      to: { path: '(?:^|/)apps/server/' },
    },
    {
      name: 'cli-no-apps',
      comment:
        'the client CLI talks to the server over HTTP only; it shares types via @skills/contracts.',
      severity: 'error',
      from: { path: '(?:^|/)packages/cli/' },
      to: { path: '(?:^|/)apps/' },
    },
    {
      name: 'api-no-ui',
      comment: 'the web API client (src/api) does not depend on UI components.',
      severity: 'error',
      from: { path: '(?:^|/)apps/web/src/api/' },
      to: { path: '(?:^|/)apps/web/src/components/' },
    },
    {
      name: 'no-circular',
      comment: 'circular dependencies are forbidden.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    parser: 'swc',
    tsPreCompilationDeps: true,
    // Resolves the web app's `@/` alias (apps/web/src); the server has no path aliases.
    webpackConfig: { fileName: '.dependency-cruiser.resolve.cjs' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
