# skills-registry

Client CLI for [Skills Registry](https://github.com/ai-pipes/skills-registry), a self-hosted
skills registry for Claude Code and other coding agents. It imports skills from public GitHub
repositories into your registry, updates them from upstream, and installs them for any agent
(Claude Code, Codex, Cursor and others). It talks to the server only over its REST API with an API
token.

Requires Node.js ≥ 22.

```bash
npm install -g @isqanderm/skills-registry
```

## Sign in

Create a token on the server's **Tokens** page, then (the token is read from stdin and not echoed):

```bash
skills-registry login https://skills.example.com
```

The config is stored in `~/.config/skills-registry/config.json` (mode `0600`).
`SKILLS_REGISTRY_URL` and `SKILLS_REGISTRY_TOKEN` take precedence over it (handy in CI).

## Commands

```bash
skills-registry list [--folder <slug>]
skills-registry search <query> [--folder <slug>]

# import from GitHub: owner/repo or https://github.com/owner/repo[/tree/<ref>/<path>]
skills-registry import anthropics/skills --skill pdf --dry-run
skills-registry import https://github.com/anthropics/skills/tree/main/skills/pdf --folder documents

# new version from upstream when there is a new commit there
skills-registry update pdf --dry-run
skills-registry update pdf

# install: a copy in ./.agents/skills/<slug> plus links for agents; -g installs into your home directory
skills-registry install pdf -a claude-code
skills-registry uninstall pdf -a claude-code

skills-registry logout
```

`skills-registry` without arguments prints the full usage. Exit codes: `0` success, `1` the
operation failed, `2` wrong invocation.

## Environment

| Variable                                       | Meaning                                            |
| ---------------------------------------------- | -------------------------------------------------- |
| `SKILLS_REGISTRY_URL`, `SKILLS_REGISTRY_TOKEN` | Override the saved login                           |
| `GITHUB_TOKEN`                                 | Optional; raises the GitHub API rate limit         |
| `GITHUB_API_URL`                               | Default `https://api.github.com`                   |
| `SKILLS_REGISTRY_MAX_TARBALL_BYTES`            | Max compressed repository archive, default 200 MiB |
| `SKILLS_REGISTRY_MAX_UNPACKED_BYTES`           | Max unpacked size, default 1 GiB                   |

## License

MIT
