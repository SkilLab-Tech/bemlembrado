import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";
import { testEnv } from "./helpers/env";

// Apply the real D1 migrations once into the pool's D1 before any test. With
// isolatedStorage the migrated schema persists as the base layer while each
// test's writes roll back, so tests start from a clean, migrated database.
beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
