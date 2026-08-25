# BemLembrado — Roadmap

## Fases
| Fase | Foco |
|---|---|
| **F0** | Bootstrap do repo & organização (infra/harness/docs) |
| **F1** | Scaffold & fundação de dados (data model) |
| **F2** | Memory core |
| **F3** | Emitter cache-aware (o diferencial) |
| **F4** | MCP + REST + telemetria → **MVP checkpoint** |
| **F5** | Hardening V1 (self-host, OAuth, consolidação, KV, LGPD) |
| **F6** | Billing, GTM, managed/white-label, docs/landing |

Escopo cobre **MVP** + **V1**. **V2** (grafo, forgetting, integrações de framework, console web) fica fora — disciplina anti-creep.

## Invariantes P0 (gates de CI bloqueantes)
- **Cache-correctness**: o prefixo estático (tools + system + histórico até o último turno do usuário) é byte-idêntico entre turnos; a memória recuperada é emitida **depois** do breakpoint de cache.
- **Tenant isolation**: toda query da data-layer carrega um namespace; dado de T2 nunca retorna para a chave de T1.

## Disciplina de deploy
- Deploy de produção é um passo **gated, autorizado por humano**.
- Gates externos: LICENSE → publicação pública · contrato Founding Members + DPA (outside legal counsel) → pré-venda/managed.
