import type { Db } from "../db/client";
import { createLogger, type Logger } from "../obs/log";
import type { Env } from "../env";
import { type DeleteVectorize, isExpired } from "./delete";

/**
 * Retention auto-purge (F5 #110–111). A scheduled sweep that deletes memories which
 * have outlived their namespace's `retention_days`, cascading to Vectorize.
 *
 * SAFETY: flag-gated (`RETENTION_PURGE_ENABLED`) and DRY-RUN by default — when the
 * flag is off it only COUNTS what it would purge and logs it, never deleting. This
 * is destructive on prod data, so it stays a no-op until explicitly enabled. The
 * eligibility rule (`isExpired`) is shared with the LGPD delete path so lazy-expiry
 * and the sweep agree. Best-effort: a per-namespace error is logged and skipped, it
 * never aborts the whole sweep.
 */

export interface RetentionDeps {
  db: Db;
  /** Absent in tests / when the binding is missing — vectors are then skipped + reported. */
  vectorize?: DeleteVectorize;
  logger: Logger;
}

export interface SweepReport {
  namespacesScanned: number;
  memoriesExpired: number;
  memoriesPurged: number;
  vectorsPurged: number;
  errors: number;
  dryRun: boolean;
}

/**
 * Sweep every namespace that has a retention policy, purging expired memories when
 * `enabled`. Returns a report; in dry-run (`enabled=false`) purged counts are 0 and
 * `memoriesExpired` reflects what WOULD be deleted.
 */
export async function sweepExpiredMemories(deps: RetentionDeps, now: number, enabled: boolean): Promise<SweepReport> {
  const namespaces = await deps.db.listNamespacesWithRetention();
  let memoriesExpired = 0;
  let memoriesPurged = 0;
  let vectorsPurged = 0;
  let errors = 0;

  for (const ns of namespaces) {
    try {
      const memories = await deps.db.listMemoriesByNamespace(ns.id);
      const expired = memories.filter((m) => isExpired(m.created_at, ns.retention_days, now));
      memoriesExpired += expired.length;
      if (!enabled || expired.length === 0) continue;

      // Vectorize first (id-based, namespace-agnostic): if this fails we retry the
      // whole namespace next run rather than orphan D1 rows against live vectors.
      const vectorIds = expired.map((m) => m.vector_id).filter((v): v is string => v !== null);
      if (deps.vectorize !== undefined && vectorIds.length > 0) {
        await deps.vectorize.deleteByIds(vectorIds);
        vectorsPurged += vectorIds.length;
      }
      for (const m of expired) {
        await deps.db.deleteMemoryById(ns.id, m.id);
        memoriesPurged += 1;
      }
    } catch (err) {
      errors += 1;
      deps.logger.log("error", "retention_sweep_namespace_failed", {
        namespace_id: ns.id,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  const report: SweepReport = { namespacesScanned: namespaces.length, memoriesExpired, memoriesPurged, vectorsPurged, errors, dryRun: !enabled };
  deps.logger.log("info", "retention_sweep", { ...report });
  return report;
}

/** Env-wired entrypoint for the scheduled handler. Reads the flag + builds deps. */
export async function runRetentionSweep(env: Env, db: Db, now: number): Promise<SweepReport> {
  const enabled = env.RETENTION_PURGE_ENABLED === "true";
  const deps: RetentionDeps = {
    db,
    logger: createLogger(),
    ...(env.VECTORIZE !== undefined ? { vectorize: env.VECTORIZE } : {}),
  };
  return sweepExpiredMemories(deps, now, enabled);
}
