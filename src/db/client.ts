/**
 * Typed D1 client — the single source of SQL (no other module writes raw SQL).
 *
 * INVARIANT #2: every namespaced read/write takes a tenant_id or namespace_id as
 * a REQUIRED, non-optional parameter — there is no unscoped table-scan helper.
 * All statements are parameterized (bound), never string-interpolated.
 */

export type MemoryKind = "semantic" | "episodic";
export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface TenantRow {
  id: string;
  name: string;
  plan: string;
  api_key_hash: string | null;
  created_at: number;
}
export interface OauthTokenRow {
  id: string;
  tenant_id: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  /** Device claim (mig 0020): 1 = this credential may read confidential namespaces. Default 0. */
  confidential?: number;
}
export interface NamespaceRow {
  id: string;
  tenant_id: string;
  label: string;
  created_at: number;
  /** Retention policy in days (mig 0011); NULL/<=0 = keep forever. */
  retention_days?: number | null;
  /** LGPD confidential ACL (mig 0020); 1 = default-EXCLUDE on read. Monotonic 0 -> 1. */
  confidential?: number;
}
export interface SessionRow {
  id: string;
  namespace_id: string;
  status: string;
  started_at: number;
}
export interface MemoryRow {
  id: string;
  namespace_id: string;
  kind: MemoryKind;
  text: string | null;
  vector_id: string | null;
  metadata_json: string | null;
  created_at: number;
  ttl: number | null;
  /** Idempotency key (mig 0007); UNIQUE per namespace when non-null. */
  dedupe_key?: string | null;
  /**
   * Vector-write confirmation (mig 0021). 1 = the Vectorize upsert for this row completed;
   * 0 = D1 row written but the vector isn't confirmed yet. Defaults to 1 (existing rows +
   * callers that don't manage the flag). add_memory writes 0 then flips to 1 after upsert,
   * so a crash never leaves an orphan VECTOR with no D1 row (the null-hydration search bug).
   */
  vector_ok?: number;
  /** When last rewritten by consolidation (mig 0013); NULL = never consolidated. */
  updated_at?: number | null;
}
export interface MessageRow {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string | null;
  token_count: number | null;
  created_at: number;
  /** Extracted entities for episodic enrichment (JSON array string; mig 0008). */
  entities_json?: string | null;
}
export interface NoteRow {
  id: string;
  namespace_id: string;
  slug: string;
  type: string;
  r2_key: string;
  created_at: number;
  updated_at: number;
}
export interface NoteLinkRow {
  from_slug: string;
  to_slug: string;
}
export type AuditAction = "read" | "write" | "export" | "delete";
export interface AuditEventRow {
  id: string;
  tenant_id: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  /** Correlates the row to the request that produced it (mig 0012); null for legacy/seam writes. */
  request_id: string | null;
  created_at: number;
  /** 1 = this op touched a CONFIDENTIAL namespace (mig 0022). Filter the sensitive-read trail on it. */
  confidential: number;
}
export interface UsageEventRow {
  id: string;
  tenant_id: string;
  session_id: string | null;
  turn: number | null;
  tokens_fresh: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  provider: string | null;
  model: string | null;
  cost_usd: number | null;
  created_at: number;
}

// --- billing — money is ALWAYS integer cents, BRL by default. ---
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";
export type BillingProvider = "mercadopago" | "stripe" | "manual";
export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan: string;
  status: SubscriptionStatus;
  provider: BillingProvider | null;
  external_ref: string | null;
  current_period_start: number | null;
  current_period_end: number | null;
  created_at: number;
  canceled_at: number | null;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export interface InvoiceRow {
  id: string;
  tenant_id: string;
  subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: InvoiceStatus;
  period_start: number | null;
  period_end: number | null;
  created_at: number;
}

export type PaymentProvider = "mercadopago" | "stripe" | "pix" | "manual";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";
export interface PaymentRow {
  id: string;
  tenant_id: string;
  invoice_id: string | null;
  provider: PaymentProvider;
  external_id: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  paid_at: number | null;
  created_at: number;
}

export type FoundingTier = "bronze" | "silver" | "gold";
export type FoundingStatus = "signal" | "contracted" | "paid" | "refunded";
export interface FoundingMemberRow {
  id: string;
  tenant_id: string | null;
  email: string;
  tier: FoundingTier;
  amount_cents: number;
  status: FoundingStatus;
  signal_at: number;
  created_at: number;
}

// --- managed BYOK — a tenant's provider key, ENCRYPTED at rest (AES-GCM). ---
export type ByokProvider = "anthropic" | "maritaca";
export interface ProviderKeyRow {
  tenant_id: string;
  provider: ByokProvider;
  ciphertext: string;
  iv: string;
  created_at: number;
}

export class Db {
  constructor(private readonly d1: D1Database) {}

  // --- tenant ---
  async insertTenant(row: TenantRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO tenant (id, name, plan, api_key_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, row.name, row.plan, row.api_key_hash, row.created_at)
      .run();
  }

  async getTenantByApiKeyHash(apiKeyHash: string): Promise<TenantRow | null> {
    return this.d1
      .prepare("SELECT * FROM tenant WHERE api_key_hash = ?")
      .bind(apiKeyHash)
      .first<TenantRow>();
  }

  async getTenantById(id: string): Promise<TenantRow | null> {
    return this.d1.prepare("SELECT * FROM tenant WHERE id = ?").bind(id).first<TenantRow>();
  }

  // --- oauth scoped tokens (mig 0014) ---
  async insertOauthToken(row: OauthTokenRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO oauth_token (id, tenant_id, token_hash, scopes, created_at, expires_at, revoked_at, confidential) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.token_hash, row.scopes, row.created_at, row.expires_at, row.revoked_at, row.confidential ?? 0)
      .run();
  }

  async getOauthTokenByHash(tokenHash: string): Promise<OauthTokenRow | null> {
    return this.d1
      .prepare("SELECT * FROM oauth_token WHERE token_hash = ?")
      .bind(tokenHash)
      .first<OauthTokenRow>();
  }

  /** List a tenant's tokens (metadata for management — the caller strips token_hash before responding). */
  async listOauthTokensByTenant(tenantId: string): Promise<OauthTokenRow[]> {
    const result = await this.d1
      .prepare("SELECT * FROM oauth_token WHERE tenant_id = ? ORDER BY created_at DESC")
      .bind(tenantId)
      .all<OauthTokenRow>();
    return result.results;
  }

  /** Revoke a token by id (tenant-scoped so one tenant cannot revoke another's). Returns rows changed. */
  async revokeOauthToken(tenantId: string, id: string, now: number): Promise<number> {
    const res = await this.d1
      .prepare("UPDATE oauth_token SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL")
      .bind(now, tenantId, id)
      .run();
    return res.meta.changes;
  }

  // --- namespace (always tenant-scoped) ---
  async insertNamespace(row: NamespaceRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO namespace (id, tenant_id, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.label, row.created_at)
      .run();
  }

  /** Race-safe create (self-heal): no-op if the namespace already exists. */
  async insertNamespaceIfAbsent(row: NamespaceRow): Promise<void> {
    await this.d1
      .prepare("INSERT OR IGNORE INTO namespace (id, tenant_id, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.label, row.created_at)
      .run();
  }

  async getNamespace(tenantId: string, label: string): Promise<NamespaceRow | null> {
    return this.d1
      .prepare("SELECT * FROM namespace WHERE tenant_id = ? AND label = ?")
      .bind(tenantId, label)
      .first<NamespaceRow>();
  }

  async listNamespacesByTenant(tenantId: string): Promise<NamespaceRow[]> {
    const result = await this.d1
      .prepare("SELECT * FROM namespace WHERE tenant_id = ? ORDER BY label ASC")
      .bind(tenantId)
      .all<NamespaceRow>();
    return result.results;
  }

  /** All namespaces (across tenants) with an active retention policy — the cron
   * sweep's work-list. System-level scan (no tenant filter): only ever called by
   * the scheduled retention purge, never on a request path. */
  async listNamespacesWithRetention(): Promise<NamespaceRow[]> {
    const result = await this.d1
      .prepare("SELECT * FROM namespace WHERE retention_days IS NOT NULL AND retention_days > 0")
      .all<NamespaceRow>();
    return result.results;
  }

  async getNamespaceById(tenantId: string, id: string): Promise<NamespaceRow | null> {
    return this.d1
      .prepare("SELECT * FROM namespace WHERE tenant_id = ? AND id = ?")
      .bind(tenantId, id)
      .first<NamespaceRow>();
  }

  /** Right-to-erasure: delete the namespace (FK CASCADE wipes memory, note,
   * note_link, session->message). Tenant-scoped so no cross-tenant delete. */
  async deleteNamespace(tenantId: string, id: string): Promise<void> {
    await this.d1.prepare("DELETE FROM namespace WHERE tenant_id = ? AND id = ?").bind(tenantId, id).run();
  }

  async setNamespaceRetention(tenantId: string, id: string, retentionDays: number | null): Promise<void> {
    await this.d1
      .prepare("UPDATE namespace SET retention_days = ? WHERE tenant_id = ? AND id = ?")
      .bind(retentionDays, tenantId, id)
      .run();
  }

  /**
   * Mark a namespace confidential (LGPD ACL, mig 0020). MONOTONIC BY CONSTRUCTION:
   * the value 1 is hard-coded — there is deliberately no method, and no bound parameter,
   * that can write 0. A downgrade is not expressible in the data layer.
   * Tenant-scoped; returns rows changed (0 = unknown/other-tenant -> caller 404s, no oracle).
   */
  async setNamespaceConfidential(tenantId: string, id: string): Promise<number> {
    const res = await this.d1
      .prepare("UPDATE namespace SET confidential = 1 WHERE tenant_id = ? AND id = ?")
      .bind(tenantId, id)
      .run();
    return res.meta.changes;
  }

  // --- memory (always namespace-scoped) ---
  async insertMemory(row: MemoryRow): Promise<void> {
    await this.d1
      .prepare(
        "INSERT INTO memory (id, namespace_id, kind, text, vector_id, metadata_json, created_at, ttl, dedupe_key, vector_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.namespace_id,
        row.kind,
        row.text,
        row.vector_id,
        row.metadata_json,
        row.created_at,
        row.ttl,
        row.dedupe_key ?? null,
        row.vector_ok ?? 1,
      )
      .run();
  }

  /** Confirm a memory's vector write (mig 0021): flip vector_ok 0→1 after the Vectorize upsert. Namespace-scoped. */
  async setMemoryVectorOk(namespaceId: string, id: string): Promise<void> {
    await this.d1.prepare("UPDATE memory SET vector_ok = 1 WHERE namespace_id = ? AND id = ?").bind(namespaceId, id).run();
  }

  /**
   * List a namespace's memories, newest first. `limit` (a positive integer) bounds the read
   * in SQL — pass it for tenant-facing paginated reads (get_page) so a large namespace is not
   * fully loaded into the Worker to return a page. Omit it where the caller genuinely needs
   * every row (LGPD delete/retention, add-dedup) — the query stays unbounded.
   */
  async listMemoriesByNamespace(namespaceId: string, limit?: number): Promise<MemoryRow[]> {
    const bounded = limit !== undefined && Number.isInteger(limit) && limit > 0;
    const result = await this.d1
      .prepare(`SELECT * FROM memory WHERE namespace_id = ? ORDER BY created_at DESC${bounded ? " LIMIT ?" : ""}`)
      .bind(...(bounded ? [namespaceId, limit] : [namespaceId]))
      .all<MemoryRow>();
    return result.results;
  }

  /** Count memories in a namespace — the basis for the per-namespace storage-abuse quota. */
  async countMemoriesByNamespace(namespaceId: string): Promise<number> {
    const row = await this.d1
      .prepare("SELECT COUNT(*) AS n FROM memory WHERE namespace_id = ?")
      .bind(namespaceId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Count namespaces owned by a tenant — the basis for the per-tenant namespace quota. */
  async countNamespacesByTenant(tenantId: string): Promise<number> {
    const row = await this.d1
      .prepare("SELECT COUNT(*) AS n FROM namespace WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Count usage events for a tenant, optionally since a timestamp and for one provider — the basis for the per-cycle turn cap (TC-1). */
  async countUsageEventsByTenant(tenantId: string, opts: { since?: number; provider?: string } = {}): Promise<number> {
    const clauses = ["tenant_id = ?"];
    const binds: (string | number)[] = [tenantId];
    if (opts.since !== undefined) {
      clauses.push("created_at >= ?");
      binds.push(opts.since);
    }
    if (opts.provider !== undefined) {
      clauses.push("provider = ?");
      binds.push(opts.provider);
    }
    const row = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM usage_event WHERE ${clauses.join(" AND ")}`)
      .bind(...binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async getMemoryById(namespaceId: string, id: string): Promise<MemoryRow | null> {
    return this.d1
      .prepare("SELECT * FROM memory WHERE namespace_id = ? AND id = ?")
      .bind(namespaceId, id)
      .first<MemoryRow>();
  }

  /** Rewrite a memory's text in place (write-time consolidation, mig 0013). Tenant-scoping is the caller's (namespaceId is already tenant-resolved). */
  async updateMemoryText(namespaceId: string, id: string, text: string, updatedAt: number): Promise<void> {
    await this.d1
      .prepare("UPDATE memory SET text = ?, updated_at = ? WHERE namespace_id = ? AND id = ?")
      .bind(text, updatedAt, namespaceId, id)
      .run();
  }

  async getMemoryByDedupeKey(namespaceId: string, dedupeKey: string): Promise<MemoryRow | null> {
    return this.d1
      .prepare("SELECT * FROM memory WHERE namespace_id = ? AND dedupe_key = ?")
      .bind(namespaceId, dedupeKey)
      .first<MemoryRow>();
  }

  async deleteMemoriesByNamespace(namespaceId: string): Promise<void> {
    await this.d1.prepare("DELETE FROM memory WHERE namespace_id = ?").bind(namespaceId).run();
  }

  /** Delete a single memory row (namespace-scoped — the retention sweep purges
   * expired rows one id at a time so it can pair each with its Vectorize vector). */
  async deleteMemoryById(namespaceId: string, id: string): Promise<void> {
    await this.d1.prepare("DELETE FROM memory WHERE namespace_id = ? AND id = ?").bind(namespaceId, id).run();
  }

  // --- note graph (always namespace-scoped; mirrors the R2 vault) ---
  async upsertNote(row: NoteRow): Promise<void> {
    await this.d1
      .prepare(
        "INSERT INTO note (id, namespace_id, slug, type, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (namespace_id, slug) DO UPDATE SET type = excluded.type, r2_key = excluded.r2_key, updated_at = excluded.updated_at",
      )
      .bind(row.id, row.namespace_id, row.slug, row.type, row.r2_key, row.created_at, row.updated_at)
      .run();
  }

  async getNoteBySlug(namespaceId: string, slug: string): Promise<NoteRow | null> {
    return this.d1
      .prepare("SELECT * FROM note WHERE namespace_id = ? AND slug = ?")
      .bind(namespaceId, slug)
      .first<NoteRow>();
  }

  async listNotesByNamespace(namespaceId: string): Promise<NoteRow[]> {
    const result = await this.d1
      .prepare("SELECT * FROM note WHERE namespace_id = ? ORDER BY slug ASC")
      .bind(namespaceId)
      .all<NoteRow>();
    return result.results;
  }

  async deleteNoteBySlug(namespaceId: string, slug: string): Promise<void> {
    await this.d1
      .batch([
        this.d1.prepare("DELETE FROM note WHERE namespace_id = ? AND slug = ?").bind(namespaceId, slug),
        this.d1.prepare("DELETE FROM note_link WHERE namespace_id = ? AND from_slug = ?").bind(namespaceId, slug),
      ]);
  }

  /** Atomically replace the outbound edges of a note (delete old, insert new). */
  async replaceNoteLinks(namespaceId: string, fromSlug: string, toSlugs: readonly string[]): Promise<void> {
    const stmts = [
      this.d1.prepare("DELETE FROM note_link WHERE namespace_id = ? AND from_slug = ?").bind(namespaceId, fromSlug),
      ...toSlugs.map((to) =>
        this.d1
          .prepare("INSERT OR IGNORE INTO note_link (namespace_id, from_slug, to_slug) VALUES (?, ?, ?)")
          .bind(namespaceId, fromSlug, to),
      ),
    ];
    await this.d1.batch(stmts);
  }

  async getBacklinks(namespaceId: string, toSlug: string): Promise<string[]> {
    const result = await this.d1
      .prepare("SELECT from_slug FROM note_link WHERE namespace_id = ? AND to_slug = ? ORDER BY from_slug ASC")
      .bind(namespaceId, toSlug)
      .all<{ from_slug: string }>();
    return result.results.map((r) => r.from_slug);
  }

  async getOutboundLinks(namespaceId: string, fromSlug: string): Promise<string[]> {
    const result = await this.d1
      .prepare("SELECT to_slug FROM note_link WHERE namespace_id = ? AND from_slug = ? ORDER BY to_slug ASC")
      .bind(namespaceId, fromSlug)
      .all<{ to_slug: string }>();
    return result.results.map((r) => r.to_slug);
  }

  /** Edges whose target note does not (yet) exist in this namespace. */
  async listOrphanLinks(namespaceId: string): Promise<NoteLinkRow[]> {
    const result = await this.d1
      .prepare(
        "SELECT nl.from_slug, nl.to_slug FROM note_link nl " +
          "LEFT JOIN note n ON n.namespace_id = nl.namespace_id AND n.slug = nl.to_slug " +
          "WHERE nl.namespace_id = ? AND n.id IS NULL ORDER BY nl.from_slug ASC, nl.to_slug ASC",
      )
      .bind(namespaceId)
      .all<NoteLinkRow>();
    return result.results;
  }

  // --- session (always namespace-scoped; D1 = source of truth, DO = runtime) ---
  async insertSessionIfAbsent(row: { id: string; namespace_id: string; started_at: number }): Promise<void> {
    await this.d1
      .prepare("INSERT OR IGNORE INTO session (id, namespace_id, started_at) VALUES (?, ?, ?)")
      .bind(row.id, row.namespace_id, row.started_at)
      .run();
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return this.d1.prepare("SELECT * FROM session WHERE id = ?").bind(id).first<SessionRow>();
  }

  /**
   * Tenant-scoped session lookup (P0 #2) + confidential ACL (P4). Returns the session
   * ONLY if it belongs to a namespace owned by tenantId AND that namespace is readable
   * under the caller's DEVICE-DERIVED claim. null on either failure -> caller maps to a
   * uniform 404, so a confidential session is indistinguishable from a missing or
   * cross-tenant one. `allowConfidential` is required (never a request param).
   */
  async getSessionForTenant(
    tenantId: string,
    sessionId: string,
    allowConfidential: boolean,
  ): Promise<(SessionRow & { ns_confidential: number }) | null> {
    return this.d1
      .prepare(
        "SELECT s.*, n.confidential AS ns_confidential FROM session s JOIN namespace n ON n.id = s.namespace_id " +
          "WHERE s.id = ? AND n.tenant_id = ? AND (n.confidential = 0 OR ? = 1)",
      )
      .bind(sessionId, tenantId, allowConfidential ? 1 : 0)
      .first<SessionRow & { ns_confidential: number }>();
  }

  /** Messages of a session, structurally scoped to a namespace (defense-in-depth). */
  async listMessagesForSession(namespaceId: string, sessionId: string): Promise<MessageRow[]> {
    const result = await this.d1
      .prepare(
        "SELECT m.* FROM message m JOIN session s ON s.id = m.session_id WHERE s.namespace_id = ? AND m.session_id = ? ORDER BY m.created_at ASC",
      )
      .bind(namespaceId, sessionId)
      .all<MessageRow>();
    return result.results;
  }

  // --- message (always session-scoped) ---
  async insertMessage(row: MessageRow): Promise<void> {
    await this.d1
      .prepare(
        "INSERT INTO message (id, session_id, role, content, token_count, created_at, entities_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.session_id,
        row.role,
        row.content,
        row.token_count,
        row.created_at,
        row.entities_json ?? null,
      )
      .run();
  }

  async listMessagesBySession(sessionId: string): Promise<MessageRow[]> {
    const result = await this.d1
      .prepare("SELECT * FROM message WHERE session_id = ? ORDER BY created_at ASC")
      .bind(sessionId)
      .all<MessageRow>();
    return result.results;
  }

  // --- usage events (always tenant-scoped) ---
  async insertUsageEvent(row: UsageEventRow): Promise<void> {
    await this.d1
      .prepare(
        "INSERT INTO usage_event (id, tenant_id, session_id, turn, tokens_fresh, tokens_cache_read, tokens_cache_write, provider, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.tenant_id,
        row.session_id,
        row.turn,
        row.tokens_fresh,
        row.tokens_cache_read,
        row.tokens_cache_write,
        row.provider,
        row.model,
        row.cost_usd,
        row.created_at,
      )
      .run();
  }

  // --- audit log (always tenant-scoped) ---
  async insertAuditEvent(row: AuditEventRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO audit_log (id, tenant_id, actor, action, target, request_id, created_at, confidential) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.actor, row.action, row.target, row.request_id, row.created_at, row.confidential)
      .run();
  }

  async listAuditEventsByTenant(tenantId: string, opts: { since?: number; until?: number } = {}): Promise<AuditEventRow[]> {
    const clauses = ["tenant_id = ?"];
    const binds: (string | number)[] = [tenantId];
    if (opts.since !== undefined) {
      clauses.push("created_at >= ?");
      binds.push(opts.since);
    }
    if (opts.until !== undefined) {
      clauses.push("created_at <= ?");
      binds.push(opts.until);
    }
    const result = await this.d1
      .prepare(`SELECT * FROM audit_log WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`)
      .bind(...binds)
      .all<AuditEventRow>();
    return result.results;
  }

  async listUsageEventsByTenant(tenantId: string, opts: { since?: number; until?: number } = {}): Promise<UsageEventRow[]> {
    const clauses = ["tenant_id = ?"];
    const binds: (string | number)[] = [tenantId];
    if (opts.since !== undefined) {
      clauses.push("created_at >= ?");
      binds.push(opts.since);
    }
    if (opts.until !== undefined) {
      clauses.push("created_at <= ?");
      binds.push(opts.until);
    }
    const result = await this.d1
      .prepare(`SELECT * FROM usage_event WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
      .bind(...binds)
      .all<UsageEventRow>();
    return result.results;
  }

  // --- billing — all tenant-scoped. ---
  async insertSubscription(row: SubscriptionRow): Promise<void> {
    await this.d1
      .prepare(
        "INSERT INTO subscription (id, tenant_id, plan, status, provider, external_ref, current_period_start, current_period_end, created_at, canceled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.tenant_id, row.plan, row.status, row.provider, row.external_ref, row.current_period_start, row.current_period_end, row.created_at, row.canceled_at)
      .run();
  }

  /** The tenant's most-recent non-canceled subscription, or null. */
  async getActiveSubscriptionByTenant(tenantId: string): Promise<SubscriptionRow | null> {
    return this.d1
      .prepare("SELECT * FROM subscription WHERE tenant_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT 1")
      .bind(tenantId)
      .first<SubscriptionRow>();
  }

  /**
   * Webhook idempotency + tenant DISCOVERY: look up a subscription by its provider ref
   * (the Stripe subscription id). Intentionally GLOBAL (not tenant-scoped) — the ref is
   * globally unique per provider (UNIQUE(provider, external_ref)) and is HOW the single
   * webhook endpoint resolves the owning tenant (the caller has no tenant yet). The
   * returned tenant_id is then authoritative for the tenant-scoped mutation that follows.
   */
  async getSubscriptionByExternalRef(provider: BillingProvider, externalRef: string): Promise<SubscriptionRow | null> {
    return this.d1
      .prepare("SELECT * FROM subscription WHERE provider = ? AND external_ref = ? ORDER BY created_at DESC LIMIT 1")
      .bind(provider, externalRef)
      .first<SubscriptionRow>();
  }

  /** Tenant-scoped: the WHERE carries tenant_id so a mis-computed id can never mutate another tenant's row (INVARIANT #2). */
  async updateSubscriptionStatus(tenantId: string, id: string, status: SubscriptionStatus, canceledAt: number | null = null): Promise<void> {
    await this.d1
      .prepare("UPDATE subscription SET status = ?, canceled_at = ? WHERE id = ? AND tenant_id = ?")
      .bind(status, canceledAt, id, tenantId)
      .run();
  }

  async insertInvoice(row: InvoiceRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO invoice (id, tenant_id, subscription_id, amount_cents, currency, status, period_start, period_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.subscription_id, row.amount_cents, row.currency, row.status, row.period_start, row.period_end, row.created_at)
      .run();
  }

  /** The invoice already covering (subscription, period_start) for this tenant, or null — the rollup's idempotency lookup. Tenant-scoped defense-in-depth. */
  async findInvoiceForPeriod(tenantId: string, subscriptionId: string, periodStart: number): Promise<InvoiceRow | null> {
    return this.d1
      .prepare("SELECT * FROM invoice WHERE tenant_id = ? AND subscription_id = ? AND period_start = ?")
      .bind(tenantId, subscriptionId, periodStart)
      .first<InvoiceRow>();
  }

  async listInvoicesByTenant(tenantId: string): Promise<InvoiceRow[]> {
    const result = await this.d1
      .prepare("SELECT * FROM invoice WHERE tenant_id = ? ORDER BY created_at DESC")
      .bind(tenantId)
      .all<InvoiceRow>();
    return result.results;
  }

  async insertPayment(row: PaymentRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO payment (id, tenant_id, invoice_id, provider, external_id, amount_cents, currency, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.invoice_id, row.provider, row.external_id, row.amount_cents, row.currency, row.status, row.paid_at, row.created_at)
      .run();
  }

  /**
   * Webhook idempotency + tenant DISCOVERY: look up a payment by its provider event id.
   * This is intentionally GLOBAL (not tenant-scoped): a provider event id is globally
   * unique per provider (UNIQUE(provider, external_id)) and is exactly HOW the single
   * webhook endpoint resolves which tenant owns the payment — the caller has no tenant
   * yet. The returned row's tenant_id is then authoritative for any follow-up mutation
   * (updatePaymentStatus is tenant-scoped). Not an API-path read; never fed a caller's tenant.
   */
  async getPaymentByProviderRef(provider: PaymentProvider, externalId: string): Promise<PaymentRow | null> {
    return this.d1
      .prepare("SELECT * FROM payment WHERE provider = ? AND external_id = ?")
      .bind(provider, externalId)
      .first<PaymentRow>();
  }

  /** Tenant-scoped: pass the tenant_id discovered via getPaymentByProviderRef so a webhook can only mutate its own payment (INVARIANT #2). */
  async updatePaymentStatus(tenantId: string, id: string, status: PaymentStatus, paidAt: number | null = null): Promise<void> {
    await this.d1
      .prepare("UPDATE payment SET status = ?, paid_at = ? WHERE id = ? AND tenant_id = ?")
      .bind(status, paidAt, id, tenantId)
      .run();
  }

  async insertFoundingMember(row: FoundingMemberRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO founding_member (id, tenant_id, email, tier, amount_cents, status, signal_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.email, row.tier, row.amount_cents, row.status, row.signal_at, row.created_at)
      .run();
  }

  /** A prospect's existing signal for a tier (idempotent signup), or null. Email is stored normalized (lower/trim) by the caller. */
  async getFoundingMemberByEmailTier(email: string, tier: FoundingTier): Promise<FoundingMemberRow | null> {
    return this.d1
      .prepare("SELECT * FROM founding_member WHERE email = ? AND tier = ?")
      .bind(email, tier)
      .first<FoundingMemberRow>();
  }

  // --- managed BYOK provider keys (always tenant-scoped; only ciphertext ever stored) ---
  /** Upsert a tenant's encrypted provider key (rotate-in-place via INSERT OR REPLACE). */
  async upsertProviderKey(row: ProviderKeyRow): Promise<void> {
    await this.d1
      .prepare("INSERT OR REPLACE INTO tenant_provider_key (tenant_id, provider, ciphertext, iv, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.tenant_id, row.provider, row.ciphertext, row.iv, row.created_at)
      .run();
  }

  async getProviderKey(tenantId: string, provider: ByokProvider): Promise<ProviderKeyRow | null> {
    return this.d1
      .prepare("SELECT * FROM tenant_provider_key WHERE tenant_id = ? AND provider = ?")
      .bind(tenantId, provider)
      .first<ProviderKeyRow>();
  }

  /** Metadata only (provider + created_at) — the ciphertext/iv never leave the data layer for listing. */
  async listProviderKeyMeta(tenantId: string): Promise<{ provider: ByokProvider; created_at: number }[]> {
    const result = await this.d1
      .prepare("SELECT provider, created_at FROM tenant_provider_key WHERE tenant_id = ? ORDER BY provider")
      .bind(tenantId)
      .all<{ provider: ByokProvider; created_at: number }>();
    return result.results;
  }

  /** Delete a tenant's provider key; returns true if a row was removed (tenant-scoped). */
  async deleteProviderKey(tenantId: string, provider: ByokProvider): Promise<boolean> {
    const res = await this.d1
      .prepare("DELETE FROM tenant_provider_key WHERE tenant_id = ? AND provider = ?")
      .bind(tenantId, provider)
      .run();
    return res.meta.changes > 0;
  }

  /** How many Founding-Member signals exist for a tier — the basis for the per-tier cap. */
  async countFoundingMembersByTier(tier: FoundingTier): Promise<number> {
    const row = await this.d1
      .prepare("SELECT COUNT(*) AS n FROM founding_member WHERE tier = ?")
      .bind(tier)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
