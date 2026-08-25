# Contributing to BemLembrado

> Read [`docs/sdd/constitution.md`](./docs/sdd/constitution.md) first — their invariants are non-negotiable.

## Workflow (one feature per PR)
```
branch ← main → edit → pnpm typecheck && pnpm lint && pnpm test
→ git add <files>  (NEVER git add -A)
→ commit (conventional commit + Co-Authored-By trailer)
→ push → gh pr create → squash-merge --delete-branch → git checkout main && git pull
```
- **Branch from `main`; never push to `main` directly.** One feature/concern per PR.
- **Conventional commits** (`feat(scope): …`, `chore(...)`, `docs(...)`, `fix(...)`, `test(...)`). Enforced by commitlint in CI.
- Reference the roadmap code in the title where applicable (e.g. `feat: …`).

## Required gates (CI blocks merge)
- `pnpm typecheck` — TS strict, **zero `any`**.
- `pnpm lint` — ESLint, `no-explicit-any` = error.
- `pnpm test` — Vitest (`@cloudflare/vitest-pool-workers`).
- **P0 invariant suites** — cache-prefix byte-identity and tenant-isolation. A PR that fails either cannot merge.
- Secret scan + clean-apply-from-zero migration check.

## Non-negotiables (constitution)
1. The retrieved Context Block is **always** emitted after the cache breakpoint — **never** in the system prompt.
2. **Tenant isolation**: every query carries a namespace; no cross-tenant access. Namespace is a required data-layer arg.
3. No data resale. LGPD by design (right-to-delete cascades to Vectorize + D1 + KV).
4. Secrets via Workers Secrets only — never committed, never logged.

## Migrations
Reserve the next number in [`docs/00-migration-ledger.md`](./docs/00-migration-ledger.md) **before** opening a schema PR. Additive only after the base tables (F1 owns 0001–0006).

## Faithful reporting
Tests failed → say so with output. Step skipped → say so. No green-washing.
