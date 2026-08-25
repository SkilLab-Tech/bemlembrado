import { defineConfig, configDefaults } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * Vitest runs IN workerd via @cloudflare/vitest-pool-workers, so tests exercise
 * the real Workers runtime with DO/D1/KV bindings. singleWorker + isolatedStorage
 * = the "shared in-memory state, run sequentially" discipline (per-test writes
 * roll back; the migrated D1 schema persists as the base layer).
 *
 * env "test" omits AI + Vectorize (no local sim → no remote proxy / no creds);
 * those layers are dependency-injected with fakes in unit tests.
 *
 * The P0 invariant suites (test/invariants/**) are RED until F2/F3 and run only
 * via `pnpm test:invariants` (INVARIANTS=1) in warn-tolerant CI steps.
 */
const invariantsOnly = process.env.INVARIANTS === "1";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        isolatedStorage: true,
        wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, API_KEY_PEPPER: "test-pepper" } },
      }),
    ],
    test: {
      setupFiles: ["./test/setup-migrations.ts"],
      include: invariantsOnly
        ? ["test/invariants/**/*.test.ts"]
        : ["test/**/*.test.ts"],
      exclude: invariantsOnly
        ? [...configDefaults.exclude]
        : [...configDefaults.exclude, "test/invariants/**"],
    },
  };
});
