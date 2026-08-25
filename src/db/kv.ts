/**
 * Typed KV hot-path wrapper. Every key is tenant-prefixed via kvKey so one tenant
 * can never read/overwrite another's hot-path entries (INVARIANT #2). Sets up
 * FR-14 (session->DO routing, cached summaries, dedupe) + the rate-limit store.
 */

export class KvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KvError";
  }
}

/** Build a tenant-scoped KV key. Refuses to build a key without a tenant id. */
export function kvKey(tenantId: string, ...parts: string[]): string {
  if (tenantId.length === 0) {
    throw new KvError("tenantId is required for a KV key");
  }
  return ["t", tenantId, ...parts].join(":");
}

export class KvStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(tenantId: string, parts: string[]): Promise<string | null> {
    return this.kv.get(kvKey(tenantId, ...parts));
  }

  async put(tenantId: string, parts: string[], value: string, ttlSeconds?: number): Promise<void> {
    await this.kv.put(
      kvKey(tenantId, ...parts),
      value,
      ttlSeconds !== undefined ? { expirationTtl: ttlSeconds } : {},
    );
  }

  async delete(tenantId: string, parts: string[]): Promise<void> {
    await this.kv.delete(kvKey(tenantId, ...parts));
  }

  /**
   * LGPD right-to-erasure for KV (closes ): delete every hot-path key scoped to
   * a namespace — the prefix `t:{tenantId}:ns:{namespaceId}:`. Paginates KV.list().
   *
   * CONVENTION (enforced by review): any hot-path writer that caches
   * namespace-scoped or personal data MUST key it under parts starting
   * `["ns", namespaceId, …]` (e.g. `put(tenant, ["ns", nsId, "summary", sid], …)`),
   * so a namespace delete purges it here. Tenant-level ephemera (rate-limit) that is
   * not namespace-scoped is intentionally NOT matched.
   */
  async purgeNamespace(tenantId: string, namespaceId: string): Promise<number> {
    const prefix = `${kvKey(tenantId, "ns", namespaceId)}:`;
    let purged = 0;
    let cursor: string | undefined;
    do {
      const page = await this.kv.list(cursor !== undefined ? { prefix, cursor } : { prefix });
      for (const key of page.keys) {
        await this.kv.delete(key.name);
        purged += 1;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    return purged;
  }
}
