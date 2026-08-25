# BemLembrado — docs index

| Doc | What it is |
|---|---|
| [self-host.md](./self-host.md) | Self-hosting guide (`npx bemlembrado init`, provisioning, migrations) |
| [sdd/constitution.md](./sdd/constitution.md) | Governing principles (stack, invariants) — **read before every phase** |
| [sdd/spec.md](./sdd/spec.md) | What + why + user stories + acceptance (MVP) |
| [sdd/plan.md](./sdd/plan.md) | Architecture, design decisions, libraries, testing |
| [00-repo-structure.md](./00-repo-structure.md) | `src/` layout + storage tiers |
| [00-migration-ledger.md](./00-migration-ledger.md) | Single monotonic D1 migration ledger |
| [ROADMAP.md](./ROADMAP.md) | Phased roadmap |
| [turn-plan.md](./turn-plan.md) | How a cache-aware turn is assembled |
| [emitter-and-savings.md](./emitter-and-savings.md) | Context emitter + cache-savings accounting |
| [retrieval-eval.md](./retrieval-eval.md) · [council-eval.md](./council-eval.md) | Retrieval + consolidation evaluation notes |
| [lgpd/](./lgpd/) | LGPD posture + DPA scaffolding |
| [decisions/](./decisions/) | Architecture decision records |

The two P0 invariants (cache-prefix byte-identity, tenant isolation) are described in
[sdd/constitution.md](./sdd/constitution.md) and enforced by CI — see the repo-root
`README.md` and `.github/workflows/ci.yml`.
