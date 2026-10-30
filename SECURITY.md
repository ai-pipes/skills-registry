# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub:
[Report a vulnerability](https://github.com/ai-pipes/skills-registry/security/advisories/new)
(repository **Security** tab → **Advisories** → **Report a vulnerability**).

Include what you can of:

- the affected component (server, web UI, MCP endpoint, client CLI) and version or commit;
- steps to reproduce or a proof of concept;
- the impact you expect (for example, data exposure, privilege escalation, code execution).

We aim to acknowledge a report within a few days, keep you updated while we work on a fix, and
credit you in the advisory unless you prefer otherwise. Please give us reasonable time to release
a fix before disclosing the issue publicly.

## Supported versions

Fixes are made on `main` and shipped in the next release. Only the latest release (and `main`)
receives security fixes; please upgrade before reporting if you can.

| Component                                | Supported      |
| ---------------------------------------- | -------------- |
| Server and web UI (`main`, latest image) | Yes            |
| Client CLI `@isqanderm/skills-registry`  | Latest version |
| Older releases                           | No             |

## Scope and deployment notes

Skills Registry is self-hosted: you run the server, Postgres and the embedding model yourself, and
you are responsible for TLS, the reverse proxy, backups and network exposure. Things worth knowing
when assessing an issue:

- API tokens (`sk_…`) are stored only as SHA-256 hashes; passwords are hashed with Argon2; session
  ids are random and stored hashed.
- The web UI is served under a strict Content Security Policy (`default-src 'self'`, no inline
  scripts or styles); skill Markdown is treated as untrusted input and sanitized.
- Mutating requests from the browser are checked against `Origin`; `/mcp` checks the `Host` header.
- By default the embedding model runs locally and the server makes no outbound requests.

In scope: vulnerabilities in this repository's code, default configuration (`docker-compose.yml`,
`Dockerfile`, `.env.example`) and the published CLI. Out of scope: issues that require a
compromised host or an operator-misconfigured deployment (for example, `TRUST_PROXY=true` without
a proxy), and vulnerabilities in third-party dependencies that are not exploitable through Skills
Registry (please report those upstream).
