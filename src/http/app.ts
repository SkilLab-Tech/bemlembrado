import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { apiKeyAuth } from "../auth/middleware";
import { ALL_SCOPES, parseScopes, type Scope } from "../auth/scopes";
import { issueScopedToken, revokeScopedToken } from "../auth/scoped-token";
import { curateTurn } from "../core/curate-turn";
import { parseTurnRequest, runTurn, type TurnDeps, toRunTurnInput } from "../core/run-turn";
import { addMemoryService, createNamespaceService, getPageService, getSessionContextService, listNamespacesService, logDecisionService, searchMemoryService } from "../core/services";
import { Db } from "../db/client";
import { KvStore } from "../db/kv";
import { assertTurnQuota, cycleStartUtc, parseAbuseConfig } from "../abuse/guards";
import { resolveQuotaGuard } from "../billing/plan-gating";
import { buildInferenceDeps, chatModelWithFallback, resolveChatProvider } from "../inference/client";
import { resolveMemoryNamespace } from "../memory/namespace-guard";
import { outOfWindowTurns, summarizeUsage } from "../usage/aggregate";
import { Audit, recordAudit } from "../lgpd/audit";
import { deleteMemory, deleteNamespace } from "../lgpd/delete";
import { exportVault } from "../lgpd/export";
import { KvFailureCorpus, toFailureRecord } from "../obs/failure-corpus";
import { registerMcp } from "../mcp";
import { registerOAuth } from "../auth/oauth";
import { buildOnboarding } from "../onboarding/connect";
import { foundingSignal } from "../billing/founding";
import { resolveCheckoutProvider } from "../billing/checkout";
import { handleStripeEvent, isStripeEvent, verifyStripeSignature } from "../billing/stripe-webhook";
import { resolveTenantKeys, storeProviderKey } from "../managed/byok";
import { deepHealth, renderStatusPage } from "./status";
import { FOUNDING_THANKS_URL, renderFoundingError, renderFoundingFull } from "./founding-page";
import { NoteGraph } from "../vault/graph";
import { VaultRetriever } from "../vault/retrieve";
import { VaultStore } from "../vault/store";
import { namespaceDepsFrom, principalOf, sessionContextDepsFrom, toolCoreDepsFrom } from "./context";
import { BadRequest, Internal, NotFound, QuotaExceeded, Unauthorized, registerErrors } from "./errors";
import { buildOpenApiSpec } from "./openapi";
import { rateLimit } from "./middleware/rate-limit";
import { requireFullAccess, requireScope } from "./middleware/require-scope";
import { accessLog } from "./middleware/access-log";
import { requestId } from "./middleware/request-id";
import { corsPolicy, securityHeaders } from "./middleware/security";

export const VERSION = "0.0.0";

/** Shared Hono environment: typed bindings + per-request variables. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    requestId?: string;
    tenant?: { id: string; plan: string };
    /** Non-reversible API-key fingerprint set by auth; the audit actor. */
    keyId?: string;
    /** Granted scopes for this request: ALL_SCOPES for an API key, the token's subset for a scoped token. */
    scopes?: Scope[];
    /** Which credential authenticated: the full-access tenant API key, or a delegated scoped token. */
    credentialType?: "apiKey" | "token";
    /** Device-derived LGPD claim set by apiKeyAuth. Absent = fail-closed (false). NEVER from input. */
    confidentialAccess?: boolean;
  };
}

/**
 * Hono app factory. `/health` stays unauthenticated and dependency-free. The
 * /v1 (REST) and /mcp groups are behind API-key auth; their routes/tools are
 * added in F4. Global error handlers render the stable envelope.
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestId);
  app.use("*", accessLog);
  app.use("*", securityHeaders);
  app.use("*", corsPolicy);

  app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

  // Public API description (unauthenticated — for SDK generators + the docs site).
  app.get("/openapi.json", (c) => c.json(buildOpenApiSpec(new URL(c.req.url).origin)));

  // Deep health: live D1 ping + binding presence (no secrets). 503 if D1 is down.
  app.get("/health/deep", async (c) => {
    const health = await deepHealth(c.env);
    return c.json({ ...health, version: VERSION }, health.status === "ok" ? 200 : 503);
  });

  // Public human status page: the same probe, rendered as a self-contained
  // (no-JS) HTML page. 503 when degraded so uptime monitors can watch it too.
  app.get("/status", async (c) => {
    const health = await deepHealth(c.env);
    return c.html(renderStatusPage(health, VERSION), health.status === "ok" ? 200 : 503);
  });

  // Founding-Members pre-sale signal. PUBLIC + unauthenticated: a prospect
  // has no API key. SIGNAL ONLY — records intent, never charges (charging not wired yet).
  // IP rate-limited (off unless RATE_LIMIT_ENABLED — MUST be on before the public landing
  // page ships, plus an anti-abuse step). LGPD: stores a prospect email only
  // (consent is checked on the form path but NOT persisted yet — gated migration, see H7);
  // erasing a pure prospect (tenant_id NULL) is a runbook op (an operator runbook).
  const foundingSchema = z.object({ email: z.email().max(320), tier: z.enum(["bronze", "silver", "gold"]) });
  app.post("/founding", rateLimit({ capacity: 5, refillPerSec: 0.05, routeClass: "founding", keyBy: "ip" }), async (c) => {
    // No-JS <form> path (site/pricing.html). The CSP is script-src 'none', so the landing
    // page can only POST a native urlencoded form — not fetch JSON, and never multipart (the
    // form has no enctype). Same schema + service as JSON below; responses are HTML (redirect
    // on success) instead of JSON.
    const isForm = (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded");
    if (isForm) {
      const body = await c.req.parseBody();
      const field = (k: string): string => (typeof body[k] === "string" ? body[k] : "");
      // Honeypot: a hidden field no human fills. If a bot filled it, ack silently (no insert).
      if (field("website").trim().length > 0) return c.redirect(FOUNDING_THANKS_URL, 303);
      // Consent gate for the human form ONLY — it does NOT protect the JSON branch below, which
      // is equally public. It is not a durable LGPD control yet: consent is not persisted (no
      // column; foundingSignal stores email+tier). When the consent column lands (a gated
      // migration), enforce it on the shared insert path so
      // both branches are covered — not here on the form branch alone.
      if (field("consent") !== "on") {
        return c.html(renderFoundingError("Please tick the consent box so we may contact you about the Founding program."), 400);
      }
      const parsed = foundingSchema.safeParse({ email: field("email"), tier: field("tier") });
      if (!parsed.success) {
        return c.html(renderFoundingError("Please enter a valid e-mail and choose a tier, then try again."), 400);
      }
      try {
        await foundingSignal(new Db(c.env.DB), parsed.data, Date.now());
      } catch (e) {
        if (e instanceof QuotaExceeded) return c.html(renderFoundingFull(parsed.data.tier), 409);
        throw e;
      }
      return c.redirect(FOUNDING_THANKS_URL, 303);
    }

    const parsed = foundingSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const result = await foundingSignal(new Db(c.env.DB), parsed.data, Date.now());
    return c.json(result, result.alreadySignaled ? 200 : 201);
  });

  // Stripe webhook. PUBLIC — Stripe calls it, no API key. Verifies the
  // signature over the RAW body (Stripe-Signature) with STRIPE_WEBHOOK_SECRET, rejecting
  // bad signatures (401) and replays (>5min, inside verify). It is the source of truth for
  // subscription state; the handler is idempotent (redelivered events are safe).
  app.post("/webhooks/stripe", async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET;
    if (secret === undefined || secret.length === 0) throw new Internal("stripe webhook is not configured");
    const raw = await c.req.text();
    const ok = await verifyStripeSignature(raw, c.req.header("stripe-signature") ?? null, secret, Date.now());
    if (!ok) throw new Unauthorized("invalid stripe signature");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequest("invalid json");
    }
    if (!isStripeEvent(parsed)) throw new BadRequest("not a stripe event");
    const result = await handleStripeEvent(new Db(c.env.DB), parsed, Date.now());
    return c.json({ received: true, ...result });
  });

  // MCP OAuth 2.1 (FR-13): public discovery + authorize/token/register so Claude's connector
  // UI can install this server. Mints the SAME blt_ scoped token as /v1/tokens, so /mcp auth
  // is unchanged. MUST be registered before the apiKeyAuth mounts below (all endpoints public).
  registerOAuth(app);

  // Authenticated surfaces (routes/tools mounted in F4). /health is never gated.
  app.use("/v1/*", apiKeyAuth);
  app.use("/mcp", apiKeyAuth); // bare /mcp (the MCP endpoint) — `/mcp/*` does not match it
  app.use("/mcp/*", apiKeyAuth);

  // Zero-config onboarding (ux-B1): one call returns the MCP connect string +
  // REST base + sane defaults. No config file to edit.
  app.get("/v1/onboarding", (c) => c.json(buildOnboarding(new URL(c.req.url).origin)));

  // REST memory ops — thin transport over the shared tool-core, which
  // owns tenant scoping + input bounds + audit. Best-effort per-tenant rate limit
  // (off unless RATE_LIMIT_ENABLED). A malformed/empty body falls through to the
  // tool-core's zod validation -> 400.
  app.post("/v1/memory", rateLimit({ capacity: 60, refillPerSec: 1, routeClass: "memory:write" }), requireScope("memory:write"), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const result = await addMemoryService(toolCoreDepsFrom(c), principalOf(c), body);
    return c.json(result, 201);
  });

  app.post("/v1/search", rateLimit({ capacity: 120, refillPerSec: 2, routeClass: "memory:search" }), requireScope("memory:read"), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const result = await searchMemoryService(toolCoreDepsFrom(c), principalOf(c), body);
    return c.json(result); // { hits, requested, returned, dropped } — honest budget accounting
  });

  // get_page (F6/P5, also exposed as the get_page MCP tool): the namespace's own
  // contents, newest first — distinct from /v1/search's semantic ranking. Same
  // service, same confidential gate as add/search (core/services.ts).
  app.get("/v1/memory", rateLimit({ capacity: 120, refillPerSec: 2, routeClass: "memory:page" }), requireScope("memory:read"), async (c) => {
    const ns = c.req.query("namespace");
    if (ns === undefined || ns.length === 0) throw new BadRequest("namespace query param is required");
    const limitRaw = c.req.query("limit");
    const result = await getPageService(namespaceDepsFrom(c), principalOf(c), {
      namespace: ns,
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
    });
    return c.json(result);
  });

  // log_decision (F6/P5, also exposed as the log_decision MCP tool): a thin
  // compose-then-delegate onto add_memory (core/services.ts) — same write path,
  // same audit, no new store.
  app.post("/v1/decisions", rateLimit({ capacity: 60, refillPerSec: 1, routeClass: "decision:write" }), requireScope("memory:write"), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const result = await logDecisionService(toolCoreDepsFrom(c), principalOf(c), body);
    return c.json(result, 201);
  });

  // Cache-aware inference turn (turn-batch): retrieve memory -> assemble request
  // (stable prefix + Context Block after the breakpoint) -> call the LLM -> persist
  // the exchange -> record usage. Tighter rate limit (real LLM calls cost money).
  app.post("/v1/turn", rateLimit({ capacity: 30, refillPerSec: 0.5, routeClass: "turn" }), requireScope("memory:write"), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const req = parseTurnRequest(body);
    // Managed BYOK: when enabled, use the tenant's own provider key over the
    // platform key for this turn. Flag-off (default) skips the lookup entirely.
    const byok =
      c.env.BYOK_ENABLED === "true" && c.env.BYOK_KEK !== undefined && c.env.BYOK_KEK.length > 0
        ? await resolveTenantKeys(new Db(c.env.DB), c.env.BYOK_KEK, principalOf(c).tenantId)
        : {};
    const { chat } = buildInferenceDeps(c.env, byok);
    const effEnv = {
      ...c.env,
      ...(byok.anthropicKey !== undefined ? { ANTHROPIC_API_KEY: byok.anthropicKey } : {}),
      ...(byok.maritacaKey !== undefined ? { MARITACA_API_KEY: byok.maritacaKey } : {}),
    };
    const chatProvider = resolveChatProvider(effEnv, req.lang ?? "en", req.provider);
    const deps: TurnDeps = { ...toolCoreDepsFrom(c), chat };
    const principal = principalOf(c);

    // Turn cap (TC-1): the load-bearing margin guard. Default (Workers-AI) inference is
    // the cost we pay and it dwarfs storage, so a flat-priced tenant is capped per cycle.
    // BYOK/premium providers (anthropic/maritaca) run on the tenant's own key — not our
    // cost — so they're never counted or blocked. Only counts when a quota guard is on.
    if (chatProvider === "workers-ai") {
      const quota = resolveQuotaGuard({
        planGatingEnabled: c.env.PLAN_GATING_ENABLED === "true",
        abuseEnabled: c.env.ABUSE_GUARDS_ENABLED === "true",
        plan: c.var.tenant?.plan,
        abuseConfig: parseAbuseConfig(c.env),
      });
      if (quota !== undefined) {
        const used = await deps.db.countUsageEventsByTenant(principal.tenantId, {
          since: cycleStartUtc(deps.now()),
          provider: "workers-ai",
        });
        assertTurnQuota(used, quota);
      }
    }
    let result;
    try {
      result = await runTurn(deps, principal, toRunTurnInput(req, chatProvider));
    } catch (err) {
      // Failure corpus: record a REDACTED, structural failure record for later
      // review/eval. Best-effort + flag-gated; never masks the original error.
      if (c.env.FAILURE_CORPUS_ENABLED === "true") {
        const corpus = new KvFailureCorpus(new KvStore(c.env.KV));
        await corpus
          .record(principal.tenantId, toFailureRecord("turn", err, { provider: chatProvider, ...(principal.requestId !== undefined ? { requestId: principal.requestId } : {}) }), Date.now())
          .catch(() => undefined);
      }
      throw err;
    }

    // Self-organizing memory (off by default): fold the exchange into the vault.
    // Best-effort + flag-gated; awaited so the write completes within the request.
    const vault = c.env.VAULT;
    if (c.env.CURATOR_ENABLED === "true" && vault !== undefined) {
      const turnDb = new Db(c.env.DB);
      const vaultStore = new VaultStore(vault);
      const ai = c.env.AI;
      const vectorize = c.env.VECTORIZE;
      // Index the curated note's chunks so /v1/notes/search can find it (when AI+Vectorize present).
      const indexVectors =
        ai !== undefined && vectorize !== undefined
          ? (nsId: string, slug: string, body: string): Promise<void> =>
              new VaultRetriever({ vault: vaultStore, graph: new NoteGraph(turnDb), ai, vectorize }).index(nsId, slug, body)
          : undefined;
      await curateTurn(
        {
          db: turnDb,
          vault: vaultStore,
          chat: chatModelWithFallback(chat, chatProvider),
          ...(indexVectors !== undefined ? { indexVectors } : {}),
        },
        {
          tenantId: principal.tenantId,
          namespaceId: result.namespaceId,
          episodeId: `${result.sessionId}:${String(deps.now())}`,
          text: `user: ${req.message}\nassistant: ${result.reply}`,
          now: deps.now(),
        },
      );
    }
    return c.json(result);
  });

  // Usage + savings telemetry (turn-batch): token splits + the savings ratio for
  // this tenant (optionally one session via ?session=). savingsRatio is honest-null
  // unless a cache-reporting provider (Anthropic) served turns.
  app.get("/v1/usage", rateLimit({ capacity: 60, refillPerSec: 1, routeClass: "usage" }), requireScope("memory:read"), async (c) => {
    const tenantId = principalOf(c).tenantId;
    const session = c.req.query("session");
    const all = await new Db(c.env.DB).listUsageEventsByTenant(tenantId);
    const rows = session !== undefined ? all.filter((r) => r.session_id === session) : all;
    const summary = summarizeUsage(rows);
    // Cold-turn flag is meaningful per session (gaps within one conversation).
    return c.json(session !== undefined ? { ...summary, coldTurns: outOfWindowTurns(rows) } : summary);
  });

  // Curated LLM-Wiki notes (turn-batch). List metadata, or read one note's markdown
  // (body from R2 = source of truth). Namespace label is tenant-scoped (uniform 404).
  app.get("/v1/notes", requireScope("memory:read"), async (c) => {
    const ns = c.req.query("namespace");
    if (ns === undefined || ns.length === 0) throw new BadRequest("namespace query param is required");
    const db = new Db(c.env.DB);
    const principal = principalOf(c);
    const { id: namespaceId, confidential } = await resolveMemoryNamespace(db, principal.tenantId, ns, principal.confidential);
    const notes = await db.listNotesByNamespace(namespaceId);
    await recordAudit(db, principal, "read", { kind: "namespace", namespace: ns }, Date.now(), confidential);
    return c.json({ notes: notes.map((n) => ({ slug: n.slug, type: n.type, updated_at: n.updated_at })) });
  });

  // Note retrieval (turn-batch) — searches the vault note: vector namespace, a
  // DIFFERENT store from episodic /v1/search (no store-split). Rate-limited (embed).
  app.post("/v1/notes/search", rateLimit({ capacity: 120, refillPerSec: 2, routeClass: "notes:search" }), requireScope("memory:read"), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({ namespace: z.string().min(1).max(200), query: z.string().min(1).max(1000), topK: z.number().int().min(1).max(50).optional(), expandBacklinks: z.boolean().optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const vault = c.env.VAULT;
    const ai = c.env.AI;
    const vectorize = c.env.VECTORIZE;
    if (vault === undefined || ai === undefined || vectorize === undefined) throw new Internal("vault/AI/Vectorize binding missing");
    const db = new Db(c.env.DB);
    const principal = principalOf(c);
    const tenantId = principal.tenantId;
    const { id: namespaceId, confidential } = await resolveMemoryNamespace(db, tenantId, parsed.data.namespace, principal.confidential);
    const retriever = new VaultRetriever({ vault: new VaultStore(vault), graph: new NoteGraph(db), ai, vectorize });
    const hits = await retriever.search({
      tenantId,
      namespaceId,
      query: parsed.data.query,
      ...(parsed.data.topK !== undefined ? { topK: parsed.data.topK } : {}),
      ...(parsed.data.expandBacklinks !== undefined ? { expandBacklinks: parsed.data.expandBacklinks } : {}),
    });
    await recordAudit(db, principal, "read", { kind: "query", namespace: parsed.data.namespace, query: parsed.data.query }, Date.now(), confidential);
    return c.json({ hits: hits.map((h) => ({ slug: h.slug, score: h.score, body: h.note?.body ?? null, related: h.related })) });
  });

  app.get("/v1/notes/:slug", requireScope("memory:read"), async (c) => {
    const ns = c.req.query("namespace");
    if (ns === undefined || ns.length === 0) throw new BadRequest("namespace query param is required");
    const vault = c.env.VAULT;
    if (vault === undefined) throw new Internal("vault binding missing");
    const principal = principalOf(c);
    const tenantId = principal.tenantId;
    const db = new Db(c.env.DB);
    const { id: namespaceId, confidential } = await resolveMemoryNamespace(db, tenantId, ns, principal.confidential);
    const slug = c.req.param("slug");
    const note = await new VaultStore(vault).getNote(tenantId, namespaceId, slug);
    if (note === null) throw new NotFound("note not found");
    await recordAudit(db, principal, "read", { kind: "memory", namespace: ns, memoryId: slug }, Date.now(), confidential);
    return c.json(note);
  });

  // get_session_context: tenant-scoped working memory + the trailing
  // Context Block (placement tool_result | mid_conv_system — NEVER system). A
  // cross-tenant or unknown session id is a uniform 404 (no oracle).
  app.get(
    "/v1/sessions/:id/context",
    rateLimit({ capacity: 120, refillPerSec: 2, routeClass: "session:context" }),
    requireScope("session:read"),
    async (c) => {
      const result = await getSessionContextService(sessionContextDepsFrom(c), principalOf(c), {
        sessionId: c.req.param("id"),
        allowMidConvSystem: c.req.query("allowMidConvSystem") === "true",
      });
      return c.json(result);
    },
  );

  // Namespace management (F6-19 / #144, headless) — list + create, also exposed as the
  // list_namespaces / create_namespace MCP tools. Logic (confidential default-EXCLUDE,
  // idempotent create, per-plan quota) lives once in core/services.ts so REST and MCP
  // cannot drift; these routes are thin transport.
  app.get("/v1/namespaces", requireScope("memory:read"), async (c) => {
    return c.json(await listNamespacesService({ db: new Db(c.env.DB) }, principalOf(c)));
  });

  app.post("/v1/namespaces", rateLimit({ capacity: 30, refillPerSec: 0.5, routeClass: "namespace:create" }), requireScope("memory:write"), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const result = await createNamespaceService(namespaceDepsFrom(c), principalOf(c), body);
    return c.json(result, result.created ? 201 : 200);
  });

  // LGPD right-to-erasure: cascade-delete a namespace across all stores.
  app.delete("/v1/namespaces/:id", requireScope("memory:delete"), async (c) => {
    const tenant = c.var.tenant;
    if (tenant === undefined) throw new Internal("auth context missing");
    const vault = c.env.VAULT;
    if (vault === undefined) throw new Internal("vault binding missing");
    const db = new Db(c.env.DB);
    const result = await deleteNamespace(
      { db, vault: new VaultStore(vault), vectorize: c.env.VECTORIZE, kv: new KvStore(c.env.KV), audit: new Audit(db) },
      tenant.id,
      c.req.param("id"),
      Date.now(),
      principalOf(c).keyId ?? tenant.id, // audit WHO erased (key fingerprint / token id)
      principalOf(c).confidential, // F2: a confidential ns is undeletable via its deterministic id without the claim
    );
    return c.json({ deleted: result });
  });

  // LGPD right-to-erasure at RECORD grain: delete ONE memory across
  // Vectorize + D1 + audit. namespace-resolved with the device confidential claim, so a
  // confidential-denied / cross-tenant / unknown id all return a uniform 404 (no oracle).
  app.delete("/v1/memories/:id", requireScope("memory:delete"), async (c) => {
    const ns = c.req.query("namespace");
    if (ns === undefined || ns.length === 0) throw new BadRequest("namespace query param is required");
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    const result = await deleteMemory(
      { db, vectorize: c.env.VECTORIZE, audit: new Audit(db) },
      {
        tenantId: principal.tenantId,
        actor: principal.keyId ?? principal.tenantId,
        namespace: ns,
        id: c.req.param("id"),
        allowConfidential: principal.confidential,
      },
      Date.now(),
    );
    return c.json(result);
  });

  // LGPD confidential ACL (P4). requireFullAccess: only the tenant ROOT credential may
  // reclassify data — a delegated token must never be able to mark (or, by construction,
  // un-mark) a namespace. MONOTONIC: 0 -> 1 only; there is no un-mark route, because
  // Db.setNamespaceConfidential cannot write 0.
  app.post("/v1/namespaces/:id/confidential", requireFullAccess(), async (c) => {
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    const id = c.req.param("id");
    const changed = await db.setNamespaceConfidential(principal.tenantId, id);
    if (changed === 0) throw new NotFound("namespace not found"); // unknown/other-tenant — no oracle
    await recordAudit(db, principal, "write", { kind: "namespace", namespace: id }, Date.now());
    return c.json({ id, confidential: true });
  });

  // LGPD right-to-portability (Art. 18) — export the tenant's whole markdown vault as a zip.
  // requireFullAccess: exportVault is DELIBERATELY confidential-ACL-blind (the data subject
  // receiving their OWN data), so ONLY the tenant ROOT credential may call it — a delegated
  // scoped/device token must never be able to export the confidential tier. exportVault writes
  // its own audit row. Scope = curated markdown vault (notes + index), not raw episodic rows.
  app.post("/v1/lgpd/export", requireFullAccess(), async (c) => {
    const vaultBinding = c.env.VAULT;
    if (vaultBinding === undefined) throw new Internal("vault binding missing");
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    const now = Date.now();
    const zip = await exportVault({ db, vault: new VaultStore(vaultBinding), audit: new Audit(db) }, principal.tenantId, now);
    // Fresh, exact-length ArrayBuffer so the body isn't a view over fflate's pool.
    return c.body(new Uint8Array(zip).buffer, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="bemlembrado-export-${principal.tenantId}-${now.toString()}.zip"`,
    });
  });

  // Scoped-token management — issue/list/revoke delegated OAuth tokens.
  // requireFullAccess: only the tenant API key can mint/revoke tokens (a scoped token,
  // being a strict subset, can never escalate). The raw token is returned ONCE on issue;
  // only hashes are stored, and list/revoke never surface the hash.
  const TokenIssue = z.object({
    scopes: z.array(z.string()).min(1),
    ttlSeconds: z.number().int().positive().max(31_536_000).optional(), // ≤ 1 year
    // LGPD confidential tier for THIS device. Default false (the locked Desktop default):
    // a device only reaches the confidential namespaces when explicitly minted with it.
    // Immutable after issue — to change the tier, revoke and mint a new token (monotonic).
    confidential: z.boolean().optional(),
  });

  app.post("/v1/tokens", requireFullAccess(), async (c) => {
    const pepper = c.env.API_KEY_PEPPER;
    if (pepper === undefined || pepper.length === 0) throw new Internal("auth is not configured");
    const parsed = TokenIssue.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const scopes = parseScopes(parsed.data.scopes.join(" ")); // drops unknown scopes
    if (scopes.length === 0) throw new BadRequest(`no valid scopes (known: ${ALL_SCOPES.join(" ")})`);
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    const issued = await issueScopedToken(db, pepper, principal.tenantId, scopes, Date.now(), {
      ...(parsed.data.ttlSeconds !== undefined ? { ttlSeconds: parsed.data.ttlSeconds } : {}),
      ...(parsed.data.confidential !== undefined ? { confidential: parsed.data.confidential } : {}),
    });
    await recordAudit(db, principal, "write", { kind: "resource", name: `token:${issued.id}` }, Date.now());
    return c.json({ id: issued.id, token: issued.token, scopes: issued.scopes, expiresAt: issued.expiresAt, confidential: issued.confidential }, 201);
  });

  app.get("/v1/tokens", requireFullAccess(), async (c) => {
    const rows = await new Db(c.env.DB).listOauthTokensByTenant(principalOf(c).tenantId);
    // Metadata only — the token_hash NEVER leaves the data layer.
    return c.json({
      tokens: rows.map((r) => ({
        id: r.id,
        scopes: r.scopes,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
        confidential: (r.confidential ?? 0) === 1, // the device's LGPD tier (never the hash)
      })),
    });
  });

  app.delete("/v1/tokens/:id", requireFullAccess(), async (c) => {
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    const revoked = await revokeScopedToken(db, principal.tenantId, c.req.param("id"), Date.now());
    if (!revoked) throw new NotFound("token not found"); // unknown/other-tenant/already-revoked — no oracle
    await recordAudit(db, principal, "delete", { kind: "resource", name: `token:${c.req.param("id")}` }, Date.now());
    return c.json({ revoked: true });
  });

  // Billing checkout. requireFullAccess — initiating billing is a tenant-
  // owner action. STATELESS w.r.t. our DB: the subscription is created by the provider's
  // webhook on payment confirmation, so this only returns the hosted redirect URL. Provider
  // defaults to Stripe (cross-border); Mercado Pago/PIX slots into the same interface once
  // its webhook manifest is verified. 500 "not configured" until Stripe creds are set.
  const CheckoutBody = z.object({
    plan: z.enum(["starter", "pro"]),
    provider: z.enum(["stripe"]).default("stripe"),
    successUrl: z.url(),
    cancelUrl: z.url(),
  });
  app.post("/v1/billing/checkout", requireFullAccess(), async (c) => {
    const parsed = CheckoutBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const principal = principalOf(c);
    const provider = resolveCheckoutProvider(c.env, parsed.data.provider);
    const session = await provider.createCheckout({
      tenantId: principal.tenantId,
      plan: parsed.data.plan,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
      clientReference: c.get("requestId") ?? principal.tenantId,
    });
    return c.json(session, 201);
  });

  // Managed BYOK: a tenant stores its own provider API key, encrypted at
  // rest (AES-GCM; KEK = Workers Secret BYOK_KEK). requireFullAccess — a tenant-owner
  // action. The raw key is WRITE-ONLY: GET returns metadata (which providers, when), never
  // the key. Used by the turn path when BYOK_ENABLED to bill inference to the tenant.
  const ByokBody = z.object({ provider: z.enum(["anthropic", "maritaca"]), apiKey: z.string().min(8).max(400) });
  app.post("/v1/managed/keys", requireFullAccess(), async (c) => {
    const kek = c.env.BYOK_KEK;
    if (kek === undefined || kek.length === 0) throw new Internal("BYOK is not configured");
    const parsed = ByokBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    await storeProviderKey(db, kek, principal.tenantId, parsed.data.provider, parsed.data.apiKey, Date.now());
    await recordAudit(db, principal, "write", { kind: "resource", name: `byok:${parsed.data.provider}` }, Date.now());
    return c.json({ stored: true, provider: parsed.data.provider }, 201);
  });

  app.get("/v1/managed/keys", requireFullAccess(), async (c) => {
    const keys = await new Db(c.env.DB).listProviderKeyMeta(principalOf(c).tenantId);
    return c.json({ keys }); // metadata only — the key material never leaves the data layer
  });

  app.delete("/v1/managed/keys/:provider", requireFullAccess(), async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "anthropic" && provider !== "maritaca") throw new NotFound("unknown provider");
    const principal = principalOf(c);
    const db = new Db(c.env.DB);
    const removed = await db.deleteProviderKey(principal.tenantId, provider);
    if (!removed) throw new NotFound("no key for that provider"); // unknown/other-tenant/already-gone — no oracle
    await recordAudit(db, principal, "delete", { kind: "resource", name: `byok:${provider}` }, Date.now());
    return c.json({ deleted: true });
  });

  // MCP transport: Streamable-HTTP server at /mcp (auth above).
  registerMcp(app);

  registerErrors(app);

  return app;
}
