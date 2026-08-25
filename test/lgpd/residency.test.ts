import { describe, expect, it } from "vitest";
import { assertResidencySatisfiable, parseRegion, residencyDisclosure, ResidencyError } from "../../src/lgpd/residency";

describe("parseRegion", () => {
  it("accepts known regions (case-insensitive)", () => {
    expect(parseRegion("br")).toBe("br");
    expect(parseRegion("BR")).toBe("br");
    expect(parseRegion("global")).toBe("global");
  });
  it("falls back when empty/undefined", () => {
    expect(parseRegion(undefined)).toBe("global");
    expect(parseRegion("")).toBe("global");
    expect(parseRegion(undefined, "eu")).toBe("eu");
  });
  it("throws on an unknown region (fail-closed)", () => {
    expect(() => parseRegion("mars")).toThrow(ResidencyError);
  });
});

describe("assertResidencySatisfiable", () => {
  it("allows a global request under any deployment", () => {
    expect(() => { assertResidencySatisfiable("global", "global"); }).not.toThrow();
    expect(() => { assertResidencySatisfiable("global", "br"); }).not.toThrow();
  });
  it("allows a matching region", () => {
    expect(() => { assertResidencySatisfiable("br", "br"); }).not.toThrow();
  });
  it("refuses a specific request under a global deployment", () => {
    expect(() => { assertResidencySatisfiable("br", "global"); }).toThrow(ResidencyError);
  });
  it("refuses a mismatch", () => {
    expect(() => { assertResidencySatisfiable("br", "eu"); }).toThrow(ResidencyError);
  });
});

describe("residencyDisclosure", () => {
  it("is explicit that global gives no guarantee", () => {
    expect(residencyDisclosure("global").toLowerCase()).toContain("no data-residency guarantee");
  });
  it("names the region and discloses KV/Vectorize are global", () => {
    const d = residencyDisclosure("br");
    expect(d).toContain("BR");
    expect(d).toContain("Vectorize");
  });
});
