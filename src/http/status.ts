import type { Env } from "../env";

/**
 * Shared deep-health probe (used by GET /health/deep as JSON and GET /status as a human
 * page). D1 is pinged live; the other bindings are presence-checked. "degraded" iff D1 is
 * down — the source of truth being unreachable is the only hard failure. No secrets, no
 * external requests: the page is self-contained (no JS), so it renders under any CSP.
 */

export type Check = "ok" | "error" | "absent";
export interface HealthResult {
  status: "ok" | "degraded";
  checks: { d1: Check; kv: Check; vectorize: Check; ai: Check; vault: Check };
}

export async function deepHealth(env: Env): Promise<HealthResult> {
  let d1: Check = "ok";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    d1 = "error";
  }
  const present = (b: unknown): Check => (b !== undefined && b !== null ? "ok" : "absent");
  return {
    status: d1 === "ok" ? "ok" : "degraded",
    checks: { d1, kv: present(env.KV), vectorize: present(env.VECTORIZE), ai: present(env.AI), vault: present(env.VAULT) },
  };
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c] ?? c);
}

const COMPONENT_LABEL: Record<string, string> = {
  d1: "Database (D1)",
  kv: "Hot-path cache (KV)",
  vectorize: "Vector index (Vectorize)",
  ai: "Workers AI",
  vault: "Notes vault (R2)",
};

/** Render the deep-health result as a self-contained (no-JS) HTML status page. */
export function renderStatusPage(health: HealthResult, version: string): string {
  const ok = health.status === "ok";
  const rows = Object.entries(health.checks)
    .map(([k, v]) => {
      const cls = v === "ok" ? "ok" : v === "absent" ? "absent" : "bad";
      const dot = v === "ok" ? "●" : v === "absent" ? "○" : "✕";
      return `<tr><td>${esc(COMPONENT_LABEL[k] ?? k)}</td><td class="${cls}">${dot} ${esc(v)}</td></tr>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>BemLembrado status</title><style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b0e14;color:#e6ecf5;line-height:1.6}
.wrap{max-width:640px;margin:0 auto;padding:48px 20px}
h1{font-size:1.6rem;letter-spacing:-.02em;margin:0 0 4px}
.status{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:600;margin:8px 0 24px}
.status.ok{background:rgba(94,234,212,.16);color:#5eead4}
.status.deg{background:rgba(246,193,119,.16);color:#f6c177}
table{width:100%;border-collapse:collapse;background:#161c28;border:1px solid #232c3d;border-radius:12px;overflow:hidden}
td{padding:12px 16px;border-bottom:1px solid #232c3d}
tr:last-child td{border-bottom:none}
td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:#5eead4}.absent{color:#9fb0c9}.bad{color:#ff8f8f}
.meta{color:#9fb0c9;font-size:.85rem;margin-top:20px}
a{color:#7aa2ff}
</style></head><body><div class="wrap">
<h1>BemLembrado status</h1>
<div class="status ${ok ? "ok" : "deg"}">${ok ? "All systems operational" : "Degraded — database unreachable"}</div>
<table><tbody>${rows}</tbody></table>
<p class="meta">Version ${esc(version)} · this page is generated live per request. Machine-readable: <a href="/health/deep">/health/deep</a>.</p>
</div></body></html>`;
}
