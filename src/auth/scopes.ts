/**
 * OAuth-style scopes. A scoped token grants a least-privilege subset of
 * these; the tenant API key implicitly has all of them. Scopes map to route classes
 * and are enforced by the scope middleware.
 */

export type Scope = "memory:read" | "memory:write" | "memory:delete" | "session:read";

export const ALL_SCOPES: readonly Scope[] = ["memory:read", "memory:write", "memory:delete", "session:read"];

const SCOPE_SET: ReadonlySet<string> = new Set<string>(ALL_SCOPES);

export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/** Parse a space-separated scope string, dropping unknown/duplicate tokens (order preserved). */
export function parseScopes(raw: string): Scope[] {
  const seen = new Set<Scope>();
  for (const token of raw.split(/\s+/)) {
    if (isScope(token)) seen.add(token);
  }
  return [...seen];
}

/** Serialize scopes to the canonical space-separated string. */
export function serializeScopes(scopes: readonly Scope[]): string {
  return scopes.join(" ");
}

export function hasScope(granted: readonly Scope[], required: Scope): boolean {
  return granted.includes(required);
}

export function hasAllScopes(granted: readonly Scope[], required: readonly Scope[]): boolean {
  return required.every((r) => granted.includes(r));
}
