import { Db } from "../../src/db/client";
import { testEnv } from "./env";

/** Reusable data-layer test harness over the pool's migrated D1. */

export function db(): Db {
  return new Db(testEnv.DB);
}

export async function resetDb(): Promise<void> {
  // FK cascade from tenant clears the whole graph.
  await testEnv.DB.exec("DELETE FROM tenant");
}

export async function seedTenant(id: string, apiKeyHash: string | null = `h-${id}`): Promise<void> {
  await db().insertTenant({ id, name: id, plan: "open", api_key_hash: apiKeyHash, created_at: 1 });
}

export async function seedNamespace(id: string, tenantId: string, label: string): Promise<void> {
  await db().insertNamespace({ id, tenant_id: tenantId, label, created_at: 1 });
}

export async function seedMemory(id: string, namespaceId: string, text: string): Promise<void> {
  await db().insertMemory({
    id,
    namespace_id: namespaceId,
    kind: "semantic",
    text,
    vector_id: null,
    metadata_json: null,
    created_at: 1,
    ttl: null,
  });
}
