/** Vectorize per-vector metadata cap. */
export const MAX_METADATA_BYTES = 10 * 1024;

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

/**
 * Serialize memory metadata to a JSON string, rejecting payloads above the 10KiB
 * Vectorize metadata cap. Returns null when there is no metadata.
 */
export function buildMetadataJson(metadata: Record<string, unknown> | undefined): string | null {
  if (metadata === undefined) {
    return null;
  }
  const json = JSON.stringify(metadata);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_METADATA_BYTES) {
    throw new MetadataError(`metadata ${String(bytes)} bytes exceeds the ${String(MAX_METADATA_BYTES)} cap`);
  }
  return json;
}
