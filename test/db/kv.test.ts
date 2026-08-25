import { describe, expect, it } from "vitest";
import { KvError, KvStore, kvKey } from "../../src/db/kv";
import { testEnv } from "../helpers/env";

function store() {
  return new KvStore(testEnv.KV);
}

describe("kvKey", () => {
  it("builds a tenant-prefixed key", () => {
    expect(kvKey("t1", "rl", "search")).toBe("t:t1:rl:search");
  });

  it("refuses to build a key without a tenant id", () => {
    expect(() => kvKey("", "x")).toThrow(KvError);
  });
});

describe("KvStore", () => {
  it("round-trips put -> get", async () => {
    await store().put("t1", ["summary", "s1"], "hello");
    expect(await store().get("t1", ["summary", "s1"])).toBe("hello");
  });

  it("delete removes the value", async () => {
    await store().put("t1", ["k"], "v");
    await store().delete("t1", ["k"]);
    expect(await store().get("t1", ["k"])).toBeNull();
  });

  it("tenant prefixing prevents cross-tenant collisions", async () => {
    await store().put("t1", ["shared"], "t1-value");
    await store().put("t2", ["shared"], "t2-value");
    expect(await store().get("t1", ["shared"])).toBe("t1-value");
    expect(await store().get("t2", ["shared"])).toBe("t2-value");
  });

  it("honors a TTL on put", async () => {
    await store().put("t1", ["ttl"], "v", 60);
    expect(await store().get("t1", ["ttl"])).toBe("v");
  });
});
