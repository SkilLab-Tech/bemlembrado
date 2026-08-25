import type { KvStore } from "../db/kv";

/**
 * Failure corpus sink. Persists a REDACTED, tenant-scoped record of each
 * inference/turn failure so hard cases can be reviewed and folded into the retrieval
 * eval — the retrievable complement to the structured error log and the
 * AI Gateway's own request analytics.
 *
 * LGPD-safe by construction: only STRUCTURAL metadata is stored (kind, error class,
 * a length-capped message, provider/model, request id). Never the user's memory text
 * or query — a failure corpus must not become a shadow copy of personal data. Records
 * self-expire (TTL) and are tenant-level diagnostics (keyed `t:{tenant}:fail:*`, like
 * rate-limit) — intentionally NOT namespace-scoped, so a namespace delete does not
 * need to reach them.
 */

const FAILURE_TTL_SECONDS = 30 * 86_400; // 30 days
const MAX_MESSAGE = 500;

export interface FailureRecord {
  /** What failed: "turn" | "inference" | … */
  readonly kind: string;
  /** Error constructor name, e.g. "InferenceError". */
  readonly errorClass: string;
  /** Human message — length-capped, no secrets (logger redaction rules still apply upstream). */
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  readonly requestId?: string;
}

export interface FailureCorpus {
  record(tenantId: string, entry: FailureRecord, now: number): Promise<void>;
}

/** KV-backed sink. TTL'd so the corpus is bounded without a purge job. */
export class KvFailureCorpus implements FailureCorpus {
  constructor(
    private readonly kv: KvStore,
    private readonly ttlSeconds: number = FAILURE_TTL_SECONDS,
  ) {}

  async record(tenantId: string, entry: FailureRecord, now: number): Promise<void> {
    const safe: FailureRecord = { ...entry, message: entry.message.slice(0, MAX_MESSAGE) };
    // Unique per event (many failures can share a millisecond) — random suffix avoids clobber.
    const key = ["fail", `${String(now)}-${crypto.randomUUID().slice(0, 8)}`];
    await this.kv.put(tenantId, key, JSON.stringify(safe), this.ttlSeconds);
  }
}

/** Build a FailureRecord from a thrown value — never includes user content. */
export function toFailureRecord(kind: string, err: unknown, extra: { provider?: string; model?: string; requestId?: string } = {}): FailureRecord {
  const errorClass = err instanceof Error ? err.constructor.name : "Unknown";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  return {
    kind,
    errorClass,
    message,
    ...(extra.provider !== undefined ? { provider: extra.provider } : {}),
    ...(extra.model !== undefined ? { model: extra.model } : {}),
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
  };
}
