# Contributing

Thanks for your interest in Skills Registry. This guide covers what you need to build, test and
send a change.

## Prerequisites

- **Node.js 22 or newer** (`engines.node` is `>=22`; CI uses Node 22).
- **pnpm 11** through Corepack: `corepack enable` picks up the exact version from
  `packageManager` in `package.json`.
- **Docker** for the integration tests (Postgres with pgvector via Testcontainers), the smoke test
  and the end-to-end tests.

## Setup

```sh
pnpm install
```

`pnpm install` also installs the git hooks (lefthook): `pre-commit` runs `vp check --fix` on staged
files, `pre-push` runs `pnpm verify`.

## Everyday commands

| Command                 | What it does                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev:web`          | Web UI dev server (Vite); proxies `/api` and `/mcp` to `localhost:3000`                   |
| `pnpm check`            | Lint, formatting and type checks (`vp check`)                                             |
| `pnpm arch`             | Architecture rules (dependency-cruiser) and the Radix ban                                 |
| `pnpm knip`             | Unused files, exports and dependencies                                                    |
| `pnpm test`             | Unit and web tests with coverage                                                          |
| `pnpm test:int`         | Integration tests against a real Postgres (needs Docker)                                  |
| `pnpm test:e2e`         | Playwright against the built Docker image (`pnpm exec playwright install chromium` first) |
| `pnpm build`            | Server bundle (`apps/server/dist`)                                                        |
| `pnpm build:web`        | Web UI bundle (`apps/web/dist`)                                                           |
| `pnpm build:cli`        | Client CLI bundle (`packages/cli/dist/cli.js`)                                            |
| `pnpm verify`           | check, arch, knip, unit and integration tests, web and CLI builds (what CI runs)          |
| `bash scripts/smoke.sh` | End-to-end check of the `docker compose` box, including the embedding model               |

**Run `pnpm verify` before opening a pull request.**

The test with the real embedding model is skipped unless `MODEL_DIR` points to a downloaded model
(`node scripts/download-model.mjs <dir>`) or `ALLOW_MODEL_DOWNLOAD=1` is set.

## Architecture

The server is a modular monolith built along DDD lines (modules `catalog`, `search`, `identity`),
each split into `domain`, `application`, `infrastructure` and `interfaces` layers. The layer and
module boundaries are enforced by `pnpm arch` (dependency-cruiser). If a rule fails, **fix the
code**: do not disable lint rules or loosen `.dependency-cruiser.cjs` to get around it.

Start here:

- [`CLAUDE.md`](CLAUDE.md): layer rules, domain vocabulary, how to add a use case or a web page.
- [`docs/superpowers/specs/`](docs/superpowers/specs/): design specs for the server and the CLI.
- [`docs/adr/`](docs/adr/): architecture decision records. A change that reverses or extends a
  decision should come with a new ADR.

## Conventions

- **Language**: English for code, comments, docs and commit messages.
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) with a scope where it
  helps, e.g. `feat(cli): …`, `fix(catalog): …`, `docs: …`, `test(e2e): …`. Use the imperative
  mood and keep the subject short.
- **Tests are required.** Domain and application code is test-first with fake ports; adapters get
  integration tests (`apps/server/test/**/*.int.test.ts`); web pages get a test next to the page.
  Coverage of `domain` and `application` must stay at **90% or more** (lines and branches);
  `pnpm test` fails below that.
- **Web UI**: shadcn/ui on Base UI (Radix is not allowed), strict CSP (no inline scripts or
  styles, no external requests). Do not weaken the policy; see ADR 0006.
- **Dependencies**: pin exact versions, as the existing `package.json` files do.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused; split unrelated changes into separate pull requests.
3. Add or update tests and docs (README, ADR, spec) that the change affects.
4. Run `pnpm verify` (and `pnpm test:e2e` for UI changes) locally.
5. Open the pull request and fill in the template. CI runs `verify`, `smoke` and `e2e`; all must
   pass before merge.

For larger changes, open an issue first to agree on the approach.

## Security issues

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
