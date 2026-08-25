import type { Db, FoundingTier } from "../db/client";
import { QuotaExceeded } from "../http/errors";
import { FOUNDING_CATALOG } from "./catalog";

/**
 * Founding-Members pre-sale signal capture. SIGNAL ONLY — this records
 * intent, it does NOT charge. Charging is gated on the Founding-Members contract
 * (outside legal counsel); until then `status` stays
 * "signal" and `amount_cents` is the catalog price for reference only.
 *
 * Idempotent per (email, tier): a prospect who submits the same tier twice gets one row
 * and does not consume a second cap slot. The per-tier cap (FOUNDING_CATALOG) is FIRM;
 * once reached, new emails for that tier are rejected. The count-then-insert cap check
 * is best-effort under concurrency (same ceiling semantics as the abuse quotas) — the
 * DB UNIQUE(email,tier) index (mig 0016) is the hard guarantee against duplicate rows.
 */

export interface FoundingSignalInput {
  email: string;
  tier: FoundingTier;
}

export interface FoundingSignalResult {
  captured: true;
  tier: FoundingTier;
  /** Remaining slots in this tier after this signal (never negative). A scarcity signal for the pre-sale page. */
  remaining: number;
  /** true when this email had already signaled for this tier (idempotent no-op). */
  alreadySignaled: boolean;
}

export async function foundingSignal(db: Db, input: FoundingSignalInput, now: number): Promise<FoundingSignalResult> {
  const def = FOUNDING_CATALOG[input.tier];
  const email = input.email.trim().toLowerCase();

  const existing = await db.getFoundingMemberByEmailTier(email, input.tier);
  const count = await db.countFoundingMembersByTier(input.tier);
  if (existing !== null) {
    return { captured: true, tier: input.tier, remaining: Math.max(0, def.cap - count), alreadySignaled: true };
  }
  if (count >= def.cap) {
    throw new QuotaExceeded(`founding tier "${input.tier}" is full`);
  }

  await db.insertFoundingMember({
    id: crypto.randomUUID(),
    tenant_id: null, // a prospect has no tenant yet
    email,
    tier: input.tier,
    amount_cents: def.priceCents,
    status: "signal",
    signal_at: now,
    created_at: now,
  });
  return { captured: true, tier: input.tier, remaining: Math.max(0, def.cap - count - 1), alreadySignaled: false };
}
