import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { FOUNDING_CATALOG } from "../../src/billing/catalog";
import { FOUNDING_THANKS_URL } from "../../src/http/founding-page";
import { testEnv } from "../helpers/env";
import { appEnv } from "../helpers/env";

async function post(body: unknown, env: Env = appEnv): Promise<Response> {
  return createApp().request("/founding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
}

async function postForm(fields: Record<string, string>, env: Env = appEnv): Promise<Response> {
  return createApp().request(
    "/founding",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() },
    env,
  );
}

async function rowCount(): Promise<number> {
  const r = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM founding_member").first<{ n: number }>();
  return r?.n ?? 0;
}

describe("POST /founding (public pre-sale signal, F6-14 #139)", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM founding_member");
  });

  it("is PUBLIC — no API key, yet captures (201) with a scarcity count", async () => {
    const res = await post({ email: "a@x.com", tier: "gold" });
    expect(res.status).toBe(201); // not 401 — this route is unauthenticated by design
    expect(await res.json()).toMatchObject({ captured: true, tier: "gold", remaining: FOUNDING_CATALOG.gold.cap - 1, alreadySignaled: false });
  });

  it("re-submit is idempotent (200, alreadySignaled)", async () => {
    await post({ email: "b@x.com", tier: "bronze" });
    const again = await post({ email: "b@x.com", tier: "bronze" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadySignaled: true });
  });

  it("400 on a bad email or an unknown tier", async () => {
    expect((await post({ email: "not-an-email", tier: "gold" })).status).toBe(400);
    expect((await post({ email: "ok@x.com", tier: "platinum" })).status).toBe(400);
    expect((await post({ tier: "gold" })).status).toBe(400);
  });

  it("403 quota_exceeded once the tier cap is reached", async () => {
    const cap = FOUNDING_CATALOG.gold.cap;
    for (let i = 0; i < cap; i++) {
      expect((await post({ email: `g${String(i)}@x.com`, tier: "gold" })).status).toBe(201);
    }
    const over = await post({ email: "late@x.com", tier: "gold" });
    expect(over.status).toBe(403);
    expect(await over.json()).toMatchObject({ error: { code: "quota_exceeded" } });
  });
});

describe("POST /founding — no-JS form path (H6, CSP script-src 'none')", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM founding_member");
  });

  it("a valid form submit captures the row and 303-redirects to the thank-you page", async () => {
    const res = await postForm({ email: "form@x.com", tier: "silver", consent: "on" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(FOUNDING_THANKS_URL);
    expect(await rowCount()).toBe(1);
  });

  it("honeypot filled → acked (303) but NOTHING is inserted", async () => {
    const res = await postForm({ email: "bot@x.com", tier: "silver", consent: "on", website: "http://spam.example" });
    expect(res.status).toBe(303);
    expect(await rowCount()).toBe(0); // the bot's submission never reached the DB
  });

  it("missing consent → 400 HTML, no insert", async () => {
    const res = await postForm({ email: "noconsent@x.com", tier: "silver" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await rowCount()).toBe(0);
  });

  it("bad email → 400 HTML, no insert", async () => {
    const res = await postForm({ email: "nope", tier: "silver", consent: "on" });
    expect(res.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it("tier full → 409 HTML (distinct from the JSON path's error envelope)", async () => {
    const cap = FOUNDING_CATALOG.gold.cap;
    for (let i = 0; i < cap; i++) {
      expect((await post({ email: `gf${String(i)}@x.com`, tier: "gold" })).status).toBe(201);
    }
    const over = await postForm({ email: "lateform@x.com", tier: "gold", consent: "on" });
    expect(over.status).toBe(409);
    expect(over.headers.get("content-type")).toContain("text/html");
  });
});
