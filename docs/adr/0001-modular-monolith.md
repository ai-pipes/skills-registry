# 0001. Modular monolith with DDD layers

## Context

We need a single service that a team deploys on its own infrastructure with one command. There are three domains: Catalog (the core), Search (a read model), Identity. Microservices would add networking, deployment and consistency concerns with no benefit at this scale. But a "big ball of mud" in one process is not acceptable either: agents write code too, and they need strict, verifiable boundaries.

## Decision

One Node.js process (Hono) and one repository. Inside are the modules `catalog`, `search`, `identity`, each with the layers `domain` / `application` / `infrastructure` / `interfaces`. Import rules (spec §8.3) are checked by `dependency-cruiser` in `pnpm verify` and in pre-push: the domain is pure, application sees only the domain, modules talk through a public `index.ts` or domain events, inner layers do not import outer ones.

## Consequences

- Simple deployment and in-process transactions; a module can later be extracted into a service along the boundaries that already exist.
- Discipline is enforced by tooling, not by review: a violation breaks `pnpm arch`.
- The price is ceremony (ports, fakes in tests) even for simple cases.
- Shared code is limited to `shared-kernel` (Result, errors, events, Clock, the AuditLog port) and must stay dependency-free.
