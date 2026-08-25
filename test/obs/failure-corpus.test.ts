import { describe, expect, it } from "vitest";
import { KvStore } from "../../src/db/kv";
import { InferenceError } from "../../src/inference/client";
import { KvFailureCorpus, toFailureRecord } from "../../src/obs/failure-corpus";

interface Put { key: string; value: string; ttl?: number }

/** Index into a captured array with a fail-fast guard (avoids non-null assertions). */
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element ${String(i)}`);
  return v;
}

/** Minimal KVNamespace stub capturing puts (the corpus only ever puts). */
function fakeKv(): { store: KvStore; puts: Put[] } {
  const puts: Put[] = [];
  const ns = {
    put: (key: string, value: string, opts?: { expirationTtl?: number }) => {
      puts.push({ key, value, ...(opts?.expirationTtl !== undefined ? { ttl: opts.expirationTtl } : {}) });
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { store: new KvStore(ns), puts };
}

describe("toFailureRecord", () => {
  it("captures the error class + message from an Error", () => {
    const r = toFailureRecord("turn", new InferenceError("Workers AI chat failed: 5028"), { provider: "workers-ai" });
    expect(r).toMatchObject({ kind: "turn", errorClass: "InferenceError", message: "Workers AI chat failed: 5028", provider: "workers-ai" });
  });
  it("handles string + unknown throwables", () => {
    expect(toFailureRecord("x", "boom").errorClass).toBe("Unknown");
    expect(toFailureRecord("x", "boom").message).toBe("boom");
    expect(toFailureRecord("x", { weird: true }).message).toBe("unknown error");
  });
  it("omits provider/model/requestId when not given", () => {
    const r = toFailureRecord("turn", new Error("e"));
    expect(r).not.toHaveProperty("provider");
    expect(r).not.toHaveProperty("requestId");
  });
});

describe("KvFailureCorpus", () => {
  it("writes a tenant-scoped, TTL'd, JSON record", async () => {
    const { store, puts } = fakeKv();
    await new KvFailureCorpus(store).record("t1", toFailureRecord("turn", new Error("nope"), { provider: "maritaca" }), 1000);
    expect(puts).toHaveLength(1);
    const put = at(puts, 0);
    expect(put.key.startsWith("t:t1:fail:")).toBe(true);
    expect(put.ttl).toBe(30 * 86_400);
    expect(JSON.parse(put.value)).toMatchObject({ kind: "turn", errorClass: "Error", message: "nope", provider: "maritaca" });
  });

  it("caps the message at 500 chars (no unbounded payloads)", async () => {
    const { store, puts } = fakeKv();
    await new KvFailureCorpus(store).record("t1", toFailureRecord("turn", new Error("x".repeat(2000))), 1);
    expect((JSON.parse(at(puts, 0).value) as { message: string }).message.length).toBe(500);
  });

  it("uses a unique key per event (two failures in the same ms do not clobber)", async () => {
    const { store, puts } = fakeKv();
    const rec = toFailureRecord("turn", new Error("e"));
    await new KvFailureCorpus(store).record("t1", rec, 42);
    await new KvFailureCorpus(store).record("t1", rec, 42);
    expect(at(puts, 0).key).not.toBe(at(puts, 1).key);
  });

  it("honors a custom TTL", async () => {
    const { store, puts } = fakeKv();
    await new KvFailureCorpus(store, 3600).record("t1", toFailureRecord("turn", new Error("e")), 1);
    expect(at(puts, 0).ttl).toBe(3600);
  });
});
