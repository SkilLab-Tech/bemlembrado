import { describe, expect, it } from "vitest";
import {
  type AbuseConfig,
  assertMemoryQuota,
  assertNamespaceQuota,
  assertTurnQuota,
  cycleStartUtc,
  DEFAULT_ABUSE_CONFIG,
  parseAbuseConfig,
} from "../../src/abuse/guards";
import { QuotaExceeded } from "../../src/http/errors";

describe("parseAbuseConfig", () => {
  it("falls back to open-tier defaults", () => {
    expect(parseAbuseConfig({})).toStrictEqual(DEFAULT_ABUSE_CONFIG);
  });
  it("honors positive-int overrides", () => {
    const c = parseAbuseConfig({ MAX_MEMORIES_PER_NAMESPACE: "10", MAX_NAMESPACES_PER_TENANT: "3", MAX_TURNS_PER_CYCLE: "42" });
    expect(c.maxMemoriesPerNamespace).toBe(10);
    expect(c.maxNamespacesPerTenant).toBe(3);
    expect(c.maxTurnsPerCycle).toBe(42);
  });
  it("ignores garbage / non-positive overrides", () => {
    const c = parseAbuseConfig({ MAX_MEMORIES_PER_NAMESPACE: "-5", MAX_NAMESPACES_PER_TENANT: "abc", MAX_TURNS_PER_CYCLE: "0" });
    expect(c).toStrictEqual(DEFAULT_ABUSE_CONFIG);
  });
});

describe("assertMemoryQuota", () => {
  const config: AbuseConfig = { maxMemoriesPerNamespace: 3, maxNamespacesPerTenant: 10, maxTurnsPerCycle: 100 };
  it("allows a write below the cap", () => {
    expect(() => { assertMemoryQuota(2, config); }).not.toThrow();
  });
  it("refuses a write at/over the cap", () => {
    expect(() => { assertMemoryQuota(3, config); }).toThrow(QuotaExceeded);
    expect(() => { assertMemoryQuota(4, config); }).toThrow(QuotaExceeded);
  });
});

describe("assertNamespaceQuota", () => {
  const config: AbuseConfig = { maxMemoriesPerNamespace: 100, maxNamespacesPerTenant: 2, maxTurnsPerCycle: 100 };
  it("allows below cap, refuses at cap", () => {
    expect(() => { assertNamespaceQuota(1, config); }).not.toThrow();
    expect(() => { assertNamespaceQuota(2, config); }).toThrow(QuotaExceeded);
  });
});

describe("assertTurnQuota (TC-1)", () => {
  const config: AbuseConfig = { maxMemoriesPerNamespace: 100, maxNamespacesPerTenant: 10, maxTurnsPerCycle: 500 };
  it("allows a turn below the cap", () => {
    expect(() => { assertTurnQuota(499, config); }).not.toThrow();
  });
  it("refuses a turn at/over the cap", () => {
    expect(() => { assertTurnQuota(500, config); }).toThrow(QuotaExceeded);
    expect(() => { assertTurnQuota(501, config); }).toThrow(QuotaExceeded);
  });
  it("points at BYOK in the message (soft, actionable ceiling)", () => {
    expect(() => { assertTurnQuota(500, config); }).toThrow(/BYOK/);
  });
});

describe("cycleStartUtc (TC-1 billing cycle anchor)", () => {
  it("returns the 1st of the containing UTC month at 00:00", () => {
    // 2026-08-20T14:37:00Z -> 2026-08-01T00:00:00Z
    expect(cycleStartUtc(Date.UTC(2026, 7, 20, 14, 37))).toBe(Date.UTC(2026, 7, 1));
  });
  it("is idempotent on a month boundary", () => {
    const start = Date.UTC(2026, 0, 1);
    expect(cycleStartUtc(start)).toBe(start);
  });
});
