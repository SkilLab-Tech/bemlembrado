import { describe, expect, it } from "vitest";
import { MAX_METADATA_BYTES, MetadataError, buildMetadataJson } from "../../src/memory/metadata";

describe("buildMetadataJson", () => {
  it("returns null when there is no metadata", () => {
    expect(buildMetadataJson(undefined)).toBeNull();
  });

  it("serializes a small object to JSON", () => {
    expect(buildMetadataJson({ source: "chat", turn: 3 })).toBe('{"source":"chat","turn":3}');
  });

  it("round-trips through JSON", () => {
    const json = buildMetadataJson({ a: [1, 2], b: { c: true } });
    expect(JSON.parse(json ?? "null")).toStrictEqual({ a: [1, 2], b: { c: true } });
  });

  it("accepts a payload just under the cap", () => {
    const value = "x".repeat(MAX_METADATA_BYTES - 100);
    expect(buildMetadataJson({ blob: value })).not.toBeNull();
  });

  it("rejects a payload over the 10KiB cap", () => {
    const value = "x".repeat(MAX_METADATA_BYTES + 1000);
    expect(() => buildMetadataJson({ blob: value })).toThrow(MetadataError);
  });
});
