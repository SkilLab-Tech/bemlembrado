import { VERSION } from "./app";

/**
 * OpenAPI 3.1 description of the public API (turn-batch). Served unauthenticated at
 * GET /openapi.json so SDK generators + the docs site can consume it. Hand-authored
 * (small surface) rather than pulled from a framework, to keep zero extra deps.
 */
export function buildOpenApiSpec(origin: string): Record<string, unknown> {
  const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });
  const bearer = [{ bearerAuth: [] }];
  const ok = (schema: Record<string, unknown>) => ({ "200": { description: "OK", content: json(schema) } });

  return {
    openapi: "3.1.0",
    info: {
      title: "BemLembrado",
      version: VERSION,
      description: "Cache-aware memory layer for AI agents. Retrieved context is emitted after the cache breakpoint, never in the cached prefix.",
    },
    servers: [{ url: origin }],
    security: bearer,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "API key: Authorization: Bearer bl_..." } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
        MemoryId: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        SearchHit: { type: "object", properties: { id: { type: "string" }, score: { type: "number" }, text: { type: ["string", "null"] } } },
        Usage: {
          type: "object",
          properties: {
            turns: { type: "integer" },
            tokensFresh: { type: "integer" },
            tokensCacheRead: { type: "integer" },
            tokensCacheWrite: { type: "integer" },
            savingsRatio: { type: ["number", "null"], description: "null when no cache-reporting provider served turns" },
            costUsd: { type: ["number", "null"] },
          },
        },
      },
    },
    paths: {
      "/health": { get: { summary: "Liveness", security: [], responses: ok({ type: "object", properties: { status: { type: "string" }, version: { type: "string" } } }) } },
      "/founding": {
        post: {
          summary: "Founding-Members pre-sale signal (public, signal-only — no charge)",
          security: [],
          requestBody: { required: true, content: json({ type: "object", required: ["email", "tier"], properties: { email: { type: "string", format: "email" }, tier: { enum: ["bronze", "silver", "gold"] } } }) },
          responses: {
            "201": { description: "Signal captured", content: json({ type: "object", properties: { captured: { type: "boolean" }, tier: { type: "string" }, remaining: { type: "integer" }, alreadySignaled: { type: "boolean" } } }) },
            "403": { description: "Tier full", content: json({ $ref: "#/components/schemas/Error" }) },
          },
        },
      },
      "/v1/onboarding": { get: { summary: "Zero-config connect info", responses: ok({ type: "object" }) } },
      "/v1/memory": {
        post: {
          summary: "Store a memory",
          requestBody: { required: true, content: json({ type: "object", required: ["namespace", "text"], properties: { namespace: { type: "string" }, text: { type: "string", maxLength: 10000 }, kind: { enum: ["semantic", "episodic"] }, metadata: { type: "object" }, dedupeKey: { type: "string" } } }) },
          responses: { "201": { description: "Created", content: json({ $ref: "#/components/schemas/MemoryId" }) }, "400": { description: "Bad request", content: json({ $ref: "#/components/schemas/Error" }) } },
        },
        get: {
          summary: "Get a namespace page — its own memories, newest first (not semantic search)",
          parameters: [
            { name: "namespace", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: ok({ type: "object", properties: { namespace: { type: "string" }, memories: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { enum: ["semantic", "episodic"] }, text: { type: ["string", "null"] }, createdAt: { type: "integer" } } } } } }),
        },
      },
      "/v1/decisions": {
        post: {
          summary: "Log a decision (compose-then-delegate onto add_memory; no new store)",
          requestBody: { required: true, content: json({ type: "object", required: ["namespace", "title", "body"], properties: { namespace: { type: "string" }, title: { type: "string", maxLength: 300 }, body: { type: "string", maxLength: 10000 }, refs: { type: "array", items: { type: "string" } } } }) },
          responses: { "201": { description: "Created", content: json({ $ref: "#/components/schemas/MemoryId" }) }, "400": { description: "Bad request", content: json({ $ref: "#/components/schemas/Error" }) } },
        },
      },
      "/v1/search": {
        post: {
          summary: "Semantic search (episodic)",
          requestBody: { required: true, content: json({ type: "object", required: ["namespace", "query"], properties: { namespace: { type: "string" }, query: { type: "string", maxLength: 1000 }, topK: { type: "integer", minimum: 1, maximum: 50 } } }) },
          responses: ok({ type: "object", properties: { hits: { type: "array", items: { $ref: "#/components/schemas/SearchHit" } } } }),
        },
      },
      "/v1/turn": {
        post: {
          summary: "Cache-aware inference turn (retrieve memory, respond, record usage)",
          requestBody: { required: true, content: json({ type: "object", required: ["sessionId", "namespace", "message"], properties: { sessionId: { type: "string" }, namespace: { type: "string" }, message: { type: "string", maxLength: 8000 }, systemPrompt: { type: "string" }, provider: { enum: ["anthropic", "workers-ai", "maritaca"] }, lang: { type: "string" }, topK: { type: "integer" }, allowMidConvSystem: { type: "boolean" } } }) },
          responses: ok({ type: "object", properties: { sessionId: { type: "string" }, reply: { type: "string" }, provenance: { type: "array" }, usage: { type: "object" } } }),
        },
      },
      "/v1/usage": { get: { summary: "Usage + savings telemetry", parameters: [{ name: "session", in: "query", schema: { type: "string" } }], responses: ok({ $ref: "#/components/schemas/Usage" }) } },
      "/v1/sessions/{id}/context": { get: { summary: "Session working-memory Context Block", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok({ type: "object" }) } },
      "/v1/notes": { get: { summary: "List curated notes", parameters: [{ name: "namespace", in: "query", required: true, schema: { type: "string" } }], responses: ok({ type: "object" }) } },
      "/v1/notes/{slug}": { get: { summary: "Read one curated note", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }, { name: "namespace", in: "query", required: true, schema: { type: "string" } }], responses: ok({ type: "object" }) } },
      "/v1/notes/search": { post: { summary: "Search curated notes (vault RAG)", requestBody: { required: true, content: json({ type: "object", required: ["namespace", "query"], properties: { namespace: { type: "string" }, query: { type: "string" }, topK: { type: "integer" }, expandBacklinks: { type: "boolean" } } }) }, responses: ok({ type: "object" }) } },
      "/v1/namespaces": {
        get: { summary: "List the tenant's namespaces", responses: ok({ type: "object" }) },
        post: { summary: "Create a namespace (idempotent; plan-quota enforced)", requestBody: { required: true, content: json({ type: "object", required: ["namespace"], properties: { namespace: { type: "string" } } }) }, responses: ok({ type: "object" }) },
      },
      "/v1/namespaces/{id}": { delete: { summary: "Right-to-erasure: cascade-delete a namespace", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok({ type: "object" }) } },
      "/v1/memories/{id}": { delete: { summary: "Right-to-erasure at record grain: delete one memory (Vectorize + D1 + audit)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "namespace", in: "query", required: true, schema: { type: "string" } }], responses: ok({ type: "object" }) } },
      "/v1/lgpd/export": { post: { summary: "LGPD right-to-portability: export the whole vault as a zip (full-access key only; curated notes/vault, not raw episodic rows)", responses: { "200": { description: "zip archive", content: { "application/zip": { schema: { type: "string", format: "binary" } } } } } } },
      "/v1/tokens": {
        get: { summary: "List scoped tokens (metadata; full-access key only)", responses: ok({ type: "object" }) },
        post: { summary: "Issue a scoped token (full-access key only; raw token returned once)", requestBody: { required: true, content: json({ type: "object", required: ["scopes"], properties: { scopes: { type: "array", items: { type: "string" } }, ttlSeconds: { type: "integer" } } }) }, responses: ok({ type: "object" }) },
      },
      "/v1/tokens/{id}": { delete: { summary: "Revoke a scoped token (full-access key only)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok({ type: "object" }) } },
      "/v1/managed/keys": {
        get: { summary: "List BYOK provider keys (metadata only; full-access key only)", responses: ok({ type: "object", properties: { keys: { type: "array", items: { type: "object", properties: { provider: { type: "string" }, created_at: { type: "integer" } } } } } }) },
        post: { summary: "Store an encrypted BYOK provider key (full-access key only; write-only)", requestBody: { required: true, content: json({ type: "object", required: ["provider", "apiKey"], properties: { provider: { enum: ["anthropic", "maritaca"] }, apiKey: { type: "string" } } }) }, responses: { "201": { description: "Stored", content: json({ type: "object", properties: { stored: { type: "boolean" }, provider: { type: "string" } } }) } } },
      },
      "/v1/managed/keys/{provider}": { delete: { summary: "Delete a BYOK provider key (full-access key only)", parameters: [{ name: "provider", in: "path", required: true, schema: { enum: ["anthropic", "maritaca"] } }], responses: ok({ type: "object" }) } },
      "/v1/billing/checkout": {
        post: {
          summary: "Start a hosted subscription checkout (full-access key only; returns redirect URL)",
          requestBody: { required: true, content: json({ type: "object", required: ["plan", "successUrl", "cancelUrl"], properties: { plan: { enum: ["starter", "pro"] }, provider: { enum: ["stripe"], default: "stripe" }, successUrl: { type: "string", format: "uri" }, cancelUrl: { type: "string", format: "uri" } } }) },
          responses: { "201": { description: "Checkout session created", content: json({ type: "object", properties: { provider: { type: "string" }, url: { type: "string" }, externalRef: { type: "string" } } }) }, "400": { description: "Bad request", content: json({ $ref: "#/components/schemas/Error" }) } },
        },
      },
    },
  };
}
