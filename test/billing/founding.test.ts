import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/db/client";
import { FOUNDING_CATALOG } from "../../src/billing/catalog";
import { foundingSignal } from "../../src/billing/founding";
import { testEnv } from "../helpers/env";

const T0 = 1_700_000_000_000;
function db() {
  return new Db(testEnv.DB);
}

describe("founding signal", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM founding_member");
  });

  it("captures a signal: status=signal, tenant_id=null, catalog price, remaining decremented", async () => {
    const r = await foundingSignal(db(), { email: "a@x.com", tier: "gold" }, T0);
    expect(r).toStrictEqual({ captured: true, tier: "gold", remaining: FOUNDING_CATALOG.gold.cap - 1, alreadySignaled: false });

    const row = await db().getFoundingMemberByEmailTier("a@x.com", "gold");
    expect(row?.status).toBe("signal");
    expect(row?.tenant_id).toBeNull();
    expect(row?.amount_cents).toBe(FOUNDING_CATALOG.gold.priceCents); // reference only — NOT charged
  });

  it("normalizes email (trim + lowercase) so idempotency is case-insensitive", async () => {
    await foundingSignal(db(), { email: "  Bob@X.COM ", tier: "bronze" }, T0);
    const again = await foundingSignal(db(), { email: "bob@x.com", tier: "bronze" }, T0 + 1);
    expect(again.alreadySignaled).toBe(true);
    expect(await db().countFoundingMembersByTier("bronze")).toBe(1); // one row, not two
  });

  it("is idempotent: re-signing the same tier does not consume a second cap slot", async () => {
    const first = await foundingSignal(db(), { email: "c@x.com", tier: "silver" }, T0);
    const second = await foundingSignal(db(), { email: "c@x.com", tier: "silver" }, T0 + 5);
    expect(first.remaining).toBe(second.remaining); // unchanged
    expect(second.alreadySignaled).toBe(true);
  });

  it("enforces the firm per-tier cap: the (cap+1)-th distinct email is rejected", async () => {
    const cap = FOUNDING_CATALOG.gold.cap;
    for (let i = 0; i < cap; i++) {
      await foundingSignal(db(), { email: `f${String(i)}@x.com`, tier: "gold" }, T0 + i);
    }
    expect((await foundingSignal(db(), { email: `f${String(cap - 1)}@x.com`, tier: "gold" }, T0)).alreadySignaled).toBe(true); // existing still ok
    await expect(foundingSignal(db(), { email: "overflow@x.com", tier: "gold" }, T0)).rejects.toThrow(/full/);
    expect(await db().countFoundingMembersByTier("gold")).toBe(cap);
  });

  it("same email can hold different tiers (separate signals)", async () => {
    await foundingSignal(db(), { email: "multi@x.com", tier: "bronze" }, T0);
    const silver = await foundingSignal(db(), { email: "multi@x.com", tier: "silver" }, T0 + 1);
    expect(silver.alreadySignaled).toBe(false);
    expect(await db().countFoundingMembersByTier("silver")).toBe(1);
  });
});
