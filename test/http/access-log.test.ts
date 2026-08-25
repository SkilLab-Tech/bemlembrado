import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/http/app";
import { appEnv } from "../helpers/env";

describe("accessLog middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one structured line per request with method/path/status/request_id", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await createApp().request("/health", {}, appEnv);
    expect(res.status).toBe(200);

    const reqLine = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"message":"request"'));
    expect(reqLine).toBeDefined();
    expect(reqLine).toContain('"method":"GET"');
    expect(reqLine).toContain('"path":"/health"');
    expect(reqLine).toContain('"status":200');
    expect(reqLine).toContain('"request_id"');
  });

  it("does not alter the response status", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await createApp().request("/v1/memory", { method: "POST" }, appEnv); // no key
    expect(res.status).toBe(401);
  });
});
