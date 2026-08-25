#!/usr/bin/env node
/**
 * Live staging smoke. Proves the deployed worker does a REAL
 * Workers AI bge-m3 (1024-dim) -> Vectorize round-trip end-to-end, enforces
 * tenant isolation, and upholds the uniform-404 session contract.
 *
 * Reads (no secrets in this file):
 *   SMOKE_BASE_URL  e.g. https://<your-worker>.<your-subdomain>.workers.dev
 *   SMOKE_KEY_1     API key for tenant A (owns namespace SMOKE_NS)
 *   SMOKE_KEY_2     API key for tenant B (owns a DIFFERENT namespace, same label)
 *   SMOKE_NS        namespace label both tenants use (e.g. "smoke")
 *
 * A successful add+search against the 1024-dim Vectorize index IS the dim proof:
 * a wrong embedding length is rejected by the index on upsert.
 */
const BASE = process.env.SMOKE_BASE_URL;
const KEY1 = process.env.SMOKE_KEY_1;
const KEY2 = process.env.SMOKE_KEY_2;
const NS = process.env.SMOKE_NS ?? "smoke";
if (!BASE || !KEY1 || !KEY2) {
  console.error("missing SMOKE_BASE_URL / SMOKE_KEY_1 / SMOKE_KEY_2");
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, { method = "GET", key, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const marker = `smoke-${Date.now()}-the sky is blue`;

// 1. health (unauth)
const health = await req("/health");
check("health 200", health.status === 200 && health.json?.status === "ok", `status=${health.status}`);

// 2. auth gate
const noauth = await req("/v1/memory", { method: "POST", body: { namespace: NS, text: "x" } });
check("unauth /v1/memory -> 401", noauth.status === 401, `status=${noauth.status}`);

// 3. add_memory (real bge-m3 embed -> real Vectorize upsert on the 1024-dim index)
const add = await req("/v1/memory", { method: "POST", key: KEY1, body: { namespace: NS, text: marker } });
check("add_memory -> 201 {id} (real embed+Vectorize)", add.status === 201 && typeof add.json?.id === "string", `status=${add.status} body=${add.text.slice(0, 120)}`);
const id = add.json?.id;

// 4. search_memory — retry for Vectorize eventual consistency
let found = null;
for (let i = 0; i < 12 && !found; i++) {
  await sleep(2000);
  const s = await req("/v1/search", { method: "POST", key: KEY1, body: { namespace: NS, query: "the sky is blue", topK: 10 } });
  if (s.status === 200) found = (s.json?.hits ?? []).find((h) => h.id === id) ?? null;
  process.stdout.write(`  search attempt ${i + 1}: ${found ? "hit" : "no hit yet"}\r`);
}
console.log("");
check("search_memory finds the added memory (1024-dim round-trip)", found !== null && found.text === marker, found ? `text matched` : "not found after retries");

// 5. ISOLATION — tenant B searches the same label (its own, different namespace): must NOT see A's data
const iso = await req("/v1/search", { method: "POST", key: KEY2, body: { namespace: NS, query: "the sky is blue", topK: 10 } });
const leaked = iso.status === 200 && (iso.json?.hits ?? []).some((h) => h.id === id || h.text === marker);
check("tenant isolation: B cannot see A's memory", iso.status === 200 && !leaked, `status=${iso.status} hits=${(iso.json?.hits ?? []).length}`);

// 6. session context uniform 404
const ctx = await req(`/v1/sessions/does-not-exist-${Date.now()}/context`, { key: KEY1 });
check("get_session_context unknown -> 404", ctx.status === 404, `status=${ctx.status}`);

// 7. cache-aware TURN — real Workers AI (llama) end-to-end: retrieve -> respond -> persist -> usage
const turnSession = `turn-${Date.now()}`;
const turn = await req("/v1/turn", { method: "POST", key: KEY1, body: { sessionId: turnSession, namespace: NS, message: "In one sentence, why is the sky blue?" } });
const reply = typeof turn.json?.reply === "string" ? turn.json.reply : "";
check("POST /v1/turn -> 200 with a real Workers AI reply", turn.status === 200 && reply.length > 0, `status=${turn.status} provider=${turn.json?.usage?.provider ?? "?"} reply="${reply.slice(0, 60)}"`);

// 8. usage telemetry reflects the turn (savingsRatio honest-null on Workers AI)
const usage = await req(`/v1/usage?session=${turnSession}`, { key: KEY1 });
const turns = usage.json?.turns ?? 0;
check("GET /v1/usage records the turn (honest-null savings on WAI)", usage.status === 200 && turns >= 1 && usage.json?.savingsRatio === null, `status=${usage.status} turns=${turns} savingsRatio=${String(usage.json?.savingsRatio)}`);

// 9. openapi + deep health (public)
const spec = await req("/openapi.json");
check("GET /openapi.json -> 3.1.0", spec.status === 200 && spec.json?.openapi === "3.1.0", `status=${spec.status}`);
const deep = await req("/health/deep");
check("GET /health/deep -> d1 ok", deep.status === 200 && deep.json?.checks?.d1 === "ok", `status=${deep.status}`);

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
