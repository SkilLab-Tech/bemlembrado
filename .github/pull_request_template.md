<!-- Title: <type>(<F-code>): concise summary  e.g. feat: D1 migration 0001 TENANT -->

## Scope
What this PR does + acceptance (Given/When/Then or a YES/NO check).

## Ledger
- **Deps:** #… (backward only)
- **Tests:** `path/to/file.test.ts` (N cases)
- **Gate:** B-… (flag / external creds) — honest-null/flag-off default if applicable
- **Migration:** mig NNNN (additive?) — reserved in `docs/00-migration-ledger.md`

## P0 invariant checklist
- [ ] Cache-prefix byte-identity unaffected — Context Block never enters the system prompt
- [ ] Tenant namespace required at the data layer — no cross-tenant vector/row access

## Verification
- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test` green (paste/attach output)
- [ ] Free-tier respected (flag R$ + timing if any paid tier is touched)
- [ ] Faithful reporting — failures shown with output, skipped steps noted
