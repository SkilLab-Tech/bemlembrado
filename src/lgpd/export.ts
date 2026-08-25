import { unzipSync, zipSync } from "fflate";
import type { Db } from "../db/client";
import type { NoteGraph } from "../vault/graph";
import type { VaultStore } from "../vault/store";
import { parseNote, serializeNote } from "../vault/store";
import type { Audit } from "./audit";

/**
 * LGPD right-to-portability. Export a tenant's entire markdown
 * vault as a valid zip (+ manifest) and re-import it losslessly. R2 markdown is the
 * source of truth, so the export is the canonical, portable copy.
 *
 * Zip layout: `manifest.json` + `{namespaceLabel}/notes/{slug}.md` + optional
 * `{namespaceLabel}/index.md`. Notes are re-serialized via the (round-trip-proven)
 * frontmatter codec, so export is lossless.
 */

export interface ExportManifestNamespace {
  id: string;
  label: string;
  notes: string[];
}
export interface ExportManifest {
  tenant: string;
  exported_at: number;
  namespaces: ExportManifestNamespace[];
}

export interface ExportDeps {
  db: Db;
  vault: VaultStore;
  audit: Audit;
}

const MANIFEST_PATH = "manifest.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Export the tenant's whole vault as zip bytes; writes an audit row.
 *
 * LGPD note (P4): this is DELIBERATELY confidential-ACL-blind — an Art. 18 portability
 * export is the data subject receiving their OWN data, so excluding confidential namespaces
 * would breach the right. It has no HTTP route today; when it is routed, gate that route on
 * `requireFullAccess()` (the tenant ROOT credential), NEVER on the per-device `confidential`
 * claim — a delegated Desktop token must not be able to export the confidential tier.
 */
export async function exportVault(deps: ExportDeps, tenantId: string, now: number): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const namespaces = await deps.db.listNamespacesByTenant(tenantId);
  const manifest: ExportManifest = { tenant: tenantId, exported_at: now, namespaces: [] };

  for (const ns of namespaces) {
    const slugs = await deps.vault.listNotes(tenantId, ns.id);
    for (const slug of slugs) {
      const note = await deps.vault.getNote(tenantId, ns.id, slug);
      if (note !== null) files[`${ns.label}/notes/${slug}.md`] = encoder.encode(serializeNote(note));
    }
    const index = await deps.vault.getIndex(tenantId, ns.id);
    if (index !== null) files[`${ns.label}/index.md`] = encoder.encode(index);
    manifest.namespaces.push({ id: ns.id, label: ns.label, notes: slugs });
  }

  files[MANIFEST_PATH] = encoder.encode(JSON.stringify(manifest, null, 2));
  // A whole-vault portability export (Art.18) is confidential-ACL-blind by design — it returns the
  // subject's OWN data including the confidential tier. Mark the audit row confidential so the
  // sensitive-access trail (mig 0022) reflects that a full export touched confidential data.
  await deps.audit.record(tenantId, tenantId, "export", "vault", now, undefined, true);
  return zipSync(files, { level: 0 });
}

export interface ParsedExport {
  manifest: ExportManifest;
  /** zip path -> file contents */
  files: Map<string, string>;
}

/** Unzip + parse an export. Throws if the manifest is missing/invalid. */
export function readVaultExport(bytes: Uint8Array): ParsedExport {
  const unzipped = unzipSync(bytes);
  const files = new Map<string, string>();
  for (const [path, data] of Object.entries(unzipped)) files.set(path, decoder.decode(data));
  const manifestRaw = files.get(MANIFEST_PATH);
  if (manifestRaw === undefined) throw new Error("export missing manifest.json");
  const manifest = JSON.parse(manifestRaw) as ExportManifest;
  return { manifest, files };
}

export interface ImportDeps {
  db: Db;
  vault: VaultStore;
  graph: NoteGraph;
  /** Resolve-or-create the target namespace by label (self-heal #47). */
  ensureNamespaceId: (tenantId: string, label: string, now: number) => Promise<string>;
}

/**
 * Re-import an export into a target tenant (right-to-portability round-trip):
 * recreate namespaces by label, write each note back to R2 + the D1 graph.
 */
export async function importVault(deps: ImportDeps, targetTenantId: string, bytes: Uint8Array, now: number): Promise<number> {
  const { manifest, files } = readVaultExport(bytes);
  let imported = 0;
  for (const ns of manifest.namespaces) {
    const namespaceId = await deps.ensureNamespaceId(targetTenantId, ns.label, now);
    for (const slug of ns.notes) {
      const raw = files.get(`${ns.label}/notes/${slug}.md`);
      if (raw === undefined) continue;
      const note = parseNote(slug, raw);
      const put = await deps.vault.putNote(targetTenantId, namespaceId, note);
      await deps.graph.indexNote(
        namespaceId,
        {
          id: `${namespaceId}:${slug}`,
          slug,
          type: note.frontmatter.type,
          r2Key: put.key,
          createdAt: note.frontmatter.created_at,
          updatedAt: note.frontmatter.updated_at,
        },
        note.body,
      );
      imported++;
    }
  }
  return imported;
}
