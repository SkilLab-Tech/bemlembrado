# Data Processing Agreement (DPA) — scaffolding

> **Status:** scaffolding. The binding DPA text is gated on legal sign-off
> outside legal counsel sign-off (external gate).
> This document + `src/lgpd/dpa.ts` are the single source of truth the final
> agreement, onboarding, and disclosures draw from.

## Roles (managed model)
Under LGPD (Lei 13.709/2018) Arts. 5 VI/VII:

| Party | Role | Portuguese |
|---|---|---|
| **Client** | Controller | Controlador |
| **BemLembrado** (Automation Labs Tecnologia LTDA) | Operator / Processor | Operador |

The client decides *why* and *how* personal data is processed; BemLembrado
processes it **only** on the client's documented instructions (the API calls the
client's agents make). **DPO / Encarregado:** Ivan Prado — privacidade@bemlembrado.com.

## Processing purposes (closed list — minimization)
See `PROCESSING_PURPOSES` in `src/lgpd/dpa.ts`:
1. Store and retrieve agent memory on behalf of the controller.
2. Generate embeddings and consolidated summaries to serve retrieval.
3. Meter usage for billing.
4. Operate, secure, and debug the service (audit log, rate limiting).

No processing outside this list. **No data resale or re-purposing** — an
architectural rule (`NO_DATA_RESALE`), not a configurable toggle.

## Sub-processors (disclosed to the controller)
See `SUBPROCESSORS` in `src/lgpd/dpa.ts`:
- **Cloudflare, Inc.** — edge compute + storage (Workers, D1, KV, Vectorize, R2, Workers AI).
- **Anthropic** — optional premium inference, only when a tenant opts in.
- **Maritaca AI** — optional pt-BR inference, only when configured.

## Data residency — what is and isn't guaranteed
See `src/lgpd/residency.ts`. Configured per deployment via `DATA_RESIDENCY`
(`global|br|sa|us|eu|apac`; default `global`).

**Honest limits on the Cloudflare edge:**
- **D1** (source of truth) takes a **location hint** at creation — closest of
  `wnam / enam / weur / eeur / apac / oc`. There is no exact Brazil hint; the
  nearest is documented per deployment.
- **KV** and **Vectorize** are **global** by design — residency covers the
  source-of-truth store, not edge caches.

`assertResidencySatisfiable(requested, deployment)` refuses to grant a tenant a
residency the deployment cannot back — so a client is never told "your data stays
in BR" unless the deployment's D1 is actually provisioned for it. Overstating
residency would itself be an LGPD compliance risk.

## Data-subject rights
- **Right to erasure** — `DELETE /v1/namespaces/:id` cascades to R2 + Vectorize +
  KV + D1. Verified by re-query past the propagation window.
- **Retention** — configurable per-namespace TTL; scheduled purge cron (#110-111).
- **Audit** — admin actions recorded (audit_log).
