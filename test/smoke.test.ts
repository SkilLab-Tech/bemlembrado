import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("smoke", () => {
  it("GET /health returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
