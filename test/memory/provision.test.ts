import { describe, expect, it } from "vitest";
import { MAX_DIMS, MAX_TOP_K, VECTORIZE_INDEX_NAME } from "../../src/memory/vector-index";

/**
 * Confirms the Vectorize provisioning seam. Real provisioning is
 * operator-side (operator-side provisioning); here we lock the canonical
 * index name + caps the runbook and wrapper agree on. The name must equal the
 * `index_name` in wrangler.jsonc.
 */
describe("vectorize provisioning seam", () => {
  it("uses the canonical index name", () => {
    expect(VECTORIZE_INDEX_NAME).toBe("bemlembrado-mem");
  });

  it("respects the Vectorize platform caps", () => {
    expect(MAX_DIMS).toBe(1536);
    expect(MAX_TOP_K).toBe(50);
  });
});
