import type { McpToolDef, ScopeCatalog, ScopeString, ToolAnnotations } from "./connector-kit-types";
import type { Scope } from "../auth/scopes";

/**
 * BemLembrado connector SSOT: the directory-facing tool metadata + the resource:action
 * scope catalog. The connector types are vendored locally in ./connector-kit-types (a
 * minimal, type-only copy of the MCP connector-kit surface). The scope catalog mirrors
 * `Scope` (src/auth/scopes.ts) exactly — keep the two in sync when either changes.
 */
export const BEMLEMBRADO_SCOPE_CATALOG: ScopeCatalog = {
  modules: [
    { resource: "memory", actions: ["read", "write", "delete"], title: "Agent memory — semantic search, capture, erasure" },
    { resource: "session", actions: ["read"], title: "Session working memory (cache-aware Context Block)" },
  ],
  // No personas yet: every device token is a scope subset of one tenant, and the confidential
  // tier is a CLAIM on the credential, not a scope. ponytail: add a persona bundle only when a
  // second device class needs a named grant.
};

/** Directory-facing metadata for every tool src/mcp.ts registers. */
export const TOOLS: readonly McpToolDef[] = [
  {
    name: "ping",
    title: "Ping",
    description: "Liveness check — returns pong.",
    annotations: { title: "Ping", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "add_memory",
    title: "Store a memory",
    description: "Store a memory in a namespace owned by your tenant. Returns the memory id.",
    annotations: { title: "Store a memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "create_namespace",
    title: "Create a namespace",
    description: "Create a namespace owned by your tenant, or return the existing one. Idempotent. Returns the namespace id and whether it was newly created.",
    annotations: { title: "Create a namespace", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_namespaces",
    title: "List namespaces",
    description: "List the namespaces owned by your tenant, each with its id, label, and created time.",
    annotations: { title: "List namespaces", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_page",
    title: "Get a namespace page",
    description: "List the memories stored in one of your namespaces, newest first. A namespace-scoped page of contents — distinct from search_memory's semantic ranking. Returns up to `limit` rows (default 50, max 200).",
    annotations: { title: "Get a namespace page", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "log_decision",
    title: "Log a decision",
    description: "Append a decision-type memory to one of your namespaces: a title, a body, and optional refs. Returns the memory id.",
    annotations: { title: "Log a decision", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "search_memory",
    title: "Search memories",
    description: "Semantic search within one of your namespaces. Returns ranked hits.",
    annotations: { title: "Search memories", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_second_brain",
    title: "Search memories (second-brain alias)",
    description: "Compatibility alias for search_memory: semantic search within one of your namespaces. Returns ranked hits.",
    annotations: { title: "Search memories (second-brain alias)", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_session_context",
    title: "Session context block",
    description: "Working-memory Context Block for a session, pre-formatted for placement after the cache breakpoint rather than in the system prompt.",
    annotations: { title: "Session context block", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "remember_and_respond",
    title: "Cache-aware turn",
    description: "Runs a full cache-aware turn: retrieves relevant memory, produces a reply, and persists the exchange. Returns reply plus token usage.",
    annotations: { title: "Cache-aware turn", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

/** The scope each tool asserts at src/mcp.ts. `null` = no scope required (ping). */
export function scopeForTool(tool: McpToolDef): ScopeString | null {
  switch (tool.name) {
    case "add_memory":
    case "create_namespace":
    case "log_decision":
    case "remember_and_respond":
      return "memory:write" satisfies Scope;
    case "search_memory":
    case "search_second_brain":
    case "list_namespaces":
    case "get_page":
      return "memory:read" satisfies Scope;
    case "get_session_context":
      return "session:read" satisfies Scope;
    default:
      return null;
  }
}

/** Metadata spread for server.registerTool — declared and served metadata cannot drift. */
export function toolMeta(name: string): { title: string; description: string; annotations: ToolAnnotations } {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`unknown tool: ${name}`); // unreachable; locked by the catalog test
  return { title: t.title ?? name, description: t.description ?? "", annotations: { ...t.annotations } };
}
