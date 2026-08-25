import { describe, expect, it } from "vitest";
import { dpaSummary, NO_DATA_RESALE, PROCESSING_PURPOSES, ROLES, SUBPROCESSORS } from "../../src/lgpd/dpa";

describe("DPA scaffolding", () => {
  it("assigns the managed-model roles (client=controller, bemLembrado=operator)", () => {
    expect(ROLES.client).toBe("controller");
    expect(ROLES.bemLembrado).toBe("operator");
  });

  it("declares no data resale as an architectural rule", () => {
    expect(NO_DATA_RESALE).toBe(true);
  });

  it("has a closed, non-empty list of purposes and discloses Cloudflare as a sub-processor", () => {
    expect(PROCESSING_PURPOSES.length).toBeGreaterThan(0);
    expect(SUBPROCESSORS.some((s) => s.name.includes("Cloudflare"))).toBe(true);
  });

  it("dpaSummary folds in the residency disclosure for the region", () => {
    const global = dpaSummary("global");
    expect(global.residency.toLowerCase()).toContain("no data-residency guarantee");
    expect(global.roles.bemLembrado).toBe("operator");

    const br = dpaSummary("br");
    expect(br.residency).toContain("BR");
    expect(br.dpo.contact).toBe("privacidade@bemlembrado.com");
  });
});
