import { describe, expect, it } from "vitest";
import {
  COMPAT_DATE,
  DEFAULT_WORKER_NAME,
  EMBEDDING_DIMENSIONS,
  provisioningPlan,
  renderWranglerConfig,
  resourceNames,
} from "../../src/cli/provision";

describe("resourceNames", () => {
  it("derives predictable resource names from the worker name", () => {
    const n = resourceNames("acme-mem");
    expect(n).toStrictEqual({ workerName: "acme-mem", d1Name: "acme-mem", kvBinding: "KV", vectorizeIndex: "acme-mem-mem", r2Bucket: "acme-mem-vault" });
  });
  it("defaults to bemlembrado", () => {
    expect(resourceNames().workerName).toBe(DEFAULT_WORKER_NAME);
  });
});

describe("provisioningPlan", () => {
  const plan = provisioningPlan("bemlembrado");

  it("is ordered: create stores → config → migrations → secret → deploy → seed", () => {
    expect(plan.map((s) => s.id)).toStrictEqual(["d1", "kv", "vectorize", "r2", "config", "migrations", "secret", "deploy", "seed"]);
  });
  it("creates Vectorize at the bge-m3 dimension + cosine", () => {
    const v = plan.find((s) => s.id === "vectorize");
    expect(v?.command).toContain(`--dimensions=${String(EMBEDDING_DIMENSIONS)}`);
    expect(v?.command).toContain("--metric=cosine");
  });
  it("applies migrations to the REMOTE db and deploys", () => {
    expect(plan.find((s) => s.id === "migrations")?.command).toContain("migrations apply bemlembrado --remote");
    expect(plan.find((s) => s.id === "deploy")?.command).toBe("wrangler deploy");
  });
  it("marks the id-capturing steps (d1, kv)", () => {
    expect(plan.find((s) => s.id === "d1")?.capturesId).toBe("d1");
    expect(plan.find((s) => s.id === "kv")?.capturesId).toBe("kv");
  });
  it("sets the pepper via wrangler secret (never a var)", () => {
    expect(plan.find((s) => s.id === "secret")?.command).toBe("wrangler secret put API_KEY_PEPPER");
  });
});

describe("renderWranglerConfig", () => {
  const names = resourceNames("bemlembrado");
  const cfg = renderWranglerConfig(names, { d1DatabaseId: "d1-123", kvNamespaceId: "kv-456" });

  it("emits valid JSON wiring every binding to the created ids", () => {
    const parsed = JSON.parse(cfg) as {
      name: string;
      compatibility_date: string;
      d1_databases: { binding: string; database_id: string; migrations_dir: string }[];
      kv_namespaces: { binding: string; id: string }[];
      vectorize: { index_name: string }[];
      durable_objects: { bindings: { class_name: string }[] };
      migrations: { new_sqlite_classes: string[] }[];
      ai: { binding: string };
      r2_buckets: { bucket_name: string }[];
    };
    expect(parsed.name).toBe("bemlembrado");
    expect(parsed.compatibility_date).toBe(COMPAT_DATE);
    expect(parsed.d1_databases[0]).toMatchObject({ binding: "DB", database_id: "d1-123", migrations_dir: "migrations" });
    expect(parsed.kv_namespaces[0]).toMatchObject({ binding: "KV", id: "kv-456" });
    expect(parsed.vectorize[0]?.index_name).toBe("bemlembrado-mem");
    expect(parsed.durable_objects.bindings[0]?.class_name).toBe("SessionDO"); // locked DO class
    expect(parsed.migrations[0]?.new_sqlite_classes).toStrictEqual(["SessionDO"]);
    expect(parsed.ai.binding).toBe("AI");
    expect(parsed.r2_buckets[0]?.bucket_name).toBe("bemlembrado-vault");
  });

  it("includes a custom_domain route only when provided", () => {
    expect(JSON.parse(cfg)).not.toHaveProperty("routes");
    const withRoute = JSON.parse(renderWranglerConfig(names, { d1DatabaseId: "x", kvNamespaceId: "y", route: "api.example.com" })) as { routes?: { pattern: string; custom_domain: boolean }[] };
    expect(withRoute.routes?.[0]).toStrictEqual({ pattern: "api.example.com", custom_domain: true });
  });
});
