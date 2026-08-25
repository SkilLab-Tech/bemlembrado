/**
 * Connector types.
 *
 * A minimal, type-only definition of the MCP tool-descriptor + scope-catalog shapes that
 * `src/mcp/catalog.ts` uses. Kept local so this repository has no external dependency for
 * these types. Plain interfaces (erased at compile) mirroring the MCP 2025-11-25 spec
 * shapes; no runtime code.
 */

/**
 * Behaviour hints a directory reviewer reads — same fields as the MCP SDK's
 * `ToolAnnotations`. All optional; a directory submission requires some of them set.
 */
export interface ToolAnnotations {
  /** Human-readable tool name shown in client UIs. */
  title?: string;
  /** `true` ⇒ the tool only reads. */
  readOnlyHint?: boolean;
  /** `true` ⇒ the tool may modify or delete existing data. Pure creates: `false`. */
  destructiveHint?: boolean;
  /** `true` ⇒ repeated identical calls have no additional effect. */
  idempotentHint?: boolean;
  /** `true` ⇒ the tool touches something OUTSIDE this product. */
  openWorldHint?: boolean;
}

/**
 * The directory-relevant fields of a tool descriptor. `extends`-friendly, so an app's
 * richer descriptor (zod schema, permission, handler) satisfies it.
 */
export interface McpToolDef {
  /** Tool name. `^[A-Za-z0-9_.-]+$`, ≤64 chars (the connector-directory limit). */
  name: string;
  /** Spec-preferred display name (MCP `BaseMetadata.title`); outranks `annotations.title`. */
  title?: string;
  /** Narrow, accurate description of what the tool does. */
  description?: string;
  /** JSON Schema for the tool input. Opaque here. */
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
}

/** A canonical scope, `"<resource>:<action>"` (e.g. `"memory:read"`). */
export type ScopeString = string;

export interface ScopeModule {
  /** Resource segment — `^[a-z][a-z0-9_]*$` (e.g. `"memory"`, `"session"`). */
  resource: string;
  /** Actions on this resource — each `^[a-z][a-z0-9_]*$` (e.g. `["read", "write"]`). */
  actions: readonly string[];
  /** Optional human title for docs / the directory listing. */
  title?: string;
}

export interface ScopeCatalog {
  modules: readonly ScopeModule[];
  /** Optional persona → the scopes a principal of that persona may hold. */
  personas?: Readonly<Record<string, readonly ScopeString[]>>;
}
