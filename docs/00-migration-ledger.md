# BemLembrado — D1 Migration Ledger (single source of truth)

> **Regra (constitution):** as tabelas-base `0001–0006` são a fundação. Toda mudança posterior é **ALTER aditivo / nova tabela** com o **próximo número livre**. Nunca reusar nem pular números. Toda migração deve passar pelo gate de CI `clean-apply-from-zero` (aplica de um D1 vazio sem erro). Antes de abrir uma mudança que toca schema, **consultar este arquivo** e reservar o próximo número aqui.

| mig | Conteúdo | Tipo |
|---|---|---|
| 0001 | `CREATE TABLE TENANT` | base |
| 0002 | `CREATE TABLE NAMESPACE` (FK→TENANT, ON DELETE CASCADE) | base |
| 0003 | `CREATE TABLE MEMORY` (FK→NAMESPACE) | base |
| 0004 | `CREATE TABLE SESSION` (FK→NAMESPACE) | base |
| 0005 | `CREATE TABLE MESSAGE` (FK→SESSION; role inclui `tool`) | base |
| 0006 | `CREATE TABLE USAGE_EVENT` (FK→TENANT) | base |
| 0007 | `ALTER MEMORY ADD ttl, dedupe_key` (+UNIQUE parcial) | aditiva |
| 0008 | `ALTER MESSAGE ADD` cols episódicas/entity-log | aditiva |
| 0009 | `CREATE TABLE note, note_link` (LLM-Wiki vault graph) | aditiva |
| 0010 | `CREATE TABLE audit_log` (LGPD trail) | aditiva |
| 0011 | `ALTER NAMESPACE ADD retention_days` | aditiva |
| 0012 | `ALTER audit_log ADD request_id` (request correlation) | aditiva |
| 0013 | `ALTER MEMORY ADD updated_at` (provenance de consolidação write-time) | aditiva |
| 0014 | `CREATE TABLE oauth_token` (scoped access tokens; hash-only, FK→TENANT) | aditiva |
| 0015 | `CREATE TABLE subscription, invoice, payment, founding_member` (billing; money=cents; FK→TENANT CASCADE; UNIQUE(provider,external_id) p/ idempotência de webhook) | aditiva |
| 0016 | `CREATE UNIQUE INDEX` founding_member(email,tier) (idempotência do pre-sale) | aditiva |
| 0017 | `CREATE UNIQUE INDEX` invoice period | aditiva |
| 0018 | `CREATE UNIQUE INDEX` subscription external_ref | aditiva |
| 0019 | `CREATE TABLE tenant_provider_key` (BYOK; KEK em Workers Secret) | aditiva |
| 0020 | `ALTER namespace ADD confidential` + `ALTER oauth_token ADD confidential` (ACL LGPD; default-EXCLUDE; monotônico 0→1) | aditiva |
| 0021 | `ALTER memory ADD vector_ok` (D1-first write; DEFAULT 1; 0=vetor não confirmado) | aditiva |
| 0022 | `ALTER audit_log ADD confidential` (trilha de leitura sensível; DEFAULT 0; 1=leu namespace confidencial) | aditiva |

**Próximo número livre: 0023.**

Notas:
- Right-to-delete cascade (LGPD): a perna D1 é coberta por `ON DELETE CASCADE` na cadeia de FKs (TENANT→NAMESPACE→{MEMORY,SESSION→MESSAGE}); a perna Vectorize usa `MEMORY.vector_id`; a perna KV usa o contrato de invalidação. A migração **não** muda schema para o delete — é data-only.
- `USAGE_EVENT.session_id` intencionalmente **não** é FK-constrained (uso pode sobreviver a uma sessão purgada por política de retenção).
- **Ops:** sempre `wrangler d1 export` (backup) **antes** de `migrations apply` em staging/prod; migração ruim = fix-forward com nova migração aditiva (nunca editar/apagar migração já publicada). Faça sempre backup antes de aplicar.
