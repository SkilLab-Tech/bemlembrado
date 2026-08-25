# Security Policy

## Reporting a vulnerability
Report privately to **privacidade@bemlembrado.com** (DPO/owner). Do **not** open a public issue for security reports. Expect an acknowledgement within a few business days.

## Supported versions
Pre-1.0; only `main` is supported.

## Hard rules (enforced as invariants / CI gates)
- **Tenant isolation**: every query carries a namespace; no cross-tenant vector or row access is ever possible (gate: tenant-isolation suite).
- **Secrets** live in Workers Secrets only — never in `wrangler.jsonc`, never committed, never logged. CI runs a secret scan.
- **API keys** are hashed at rest; verification is constant-time.
- **No data resale** — memory is processed only for the customer's agent.
- **LGPD by design** — configurable TTL/retention; right-to-delete cascades to Vectorize + D1 + KV; managed model = client is controller, BemLembrado is operator.
- OWASP baseline; least-privilege tokens; structured logs redact secrets/PII (api_key, pepper, authorization, CPF, e-mail).

## Scope
This policy covers the BemLembrado worker, its data layer, and the managed/white-label deployment runbooks. Cloudflare-platform and inference-provider (Anthropic/Workers AI) issues should be reported to the respective vendors.
