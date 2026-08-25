import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { renderStatusPage, type HealthResult } from "../../src/http/status";
import { appEnv } from "../helpers/env";

describe("GET /status", () => {
  it("is public and renders a self-contained HTML status page (no JS, no secrets)", async () => {
    const res = await createApp().request("/status", {}, appEnv);
    expect(res.status).toBe(200); // D1 is up in the test env
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("BemLembrado status");
    expect(html).toContain("All systems operational");
    expect(html).not.toContain("<script"); // no client JS → renders under any CSP
  });

  it("renderStatusPage shows degraded + escapes; no secret leakage", () => {
    const degraded: HealthResult = { status: "degraded", checks: { d1: "error", kv: "ok", vectorize: "absent", ai: "absent", vault: "ok" } };
    const html = renderStatusPage(degraded, "1.2.3");
    expect(html).toContain("Degraded");
    expect(html).toContain("Version 1.2.3");
    expect(html).toContain("Database (D1)");
  });
});
