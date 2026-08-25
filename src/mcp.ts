import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { parseTurnRequest, runTurn, type TurnDeps, toRunTurnInput } from "./core/run-turn";
import {
  addMemoryService,
  createNamespaceService,
  getPageService,
  getSessionContextService,
  listNamespacesService,
  logDecisionService,
  type Principal,
  searchMemoryService,
  type ToolCoreDeps,
} from "./core/services";
import { hasScope, type Scope } from "./auth/scopes";
import { toolMeta } from "./mcp/catalog";
import type { AppEnv } from "./http/app";
import { principalOf, toolCoreDepsFrom } from "./http/context";
import { Forbidden } from "./http/errors";
import { buildInferenceDeps, type ChatProvider, resolveChatProvider } from "./inference/client";

/**
 * MCP server. Streamable-HTTP via the Agents SDK
 * `createMcpHandler` (package `agents`, NOT @cloudflare/agents). No Durable Object.
 *
 * TENANT BINDING (P0 #2, the top residual risk): the server is built PER REQUEST,
 * after auth, with the principal derived from THAT request's API key. Every tool
 * callback closes over that principal and passes it to the shared tool-core, which
 * resolves the tenant-owned namespace/session. A key can therefore only ever act
 * within its own tenant — there is no ambient/default tenant fallback on this path.
 */

const MCP_ROUTE = "/mcp";

function jsonResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Per-tool scope enforcement (F5 #116 security fix). REST gates scopes in Hono
 * middleware; the MCP transport has no such middleware, so each tool must assert
 * its scope here from the granted set apiKeyAuth resolved — otherwise a delegated
 * scoped token would silently gain full memory access over MCP. Throwing surfaces
 * as an MCP tool error (isError), the same way service errors already do.
 */
function assertToolScope(scopes: readonly Scope[], required: Scope): void {
  if (!hasScope(scopes, required)) {
    throw new Forbidden(`missing required scope: ${required}`);
  }
}

/** Optional cache-aware turn wiring — registers `remember_and_respond` when present. */
export interface McpTurnOptions {
  deps: TurnDeps;
  resolveProvider: (lang: string, requested?: ChatProvider) => ChatProvider;
}

/**
 * Build a server whose tools are bound to one principal + tool-core deps + the
 * caller's granted scopes. `scopes` is mandatory (fail-closed): each mutating/reading
 * tool asserts its scope so a delegated token cannot exceed its grant over MCP.
 */
export function buildMcpServer(deps: ToolCoreDeps, principal: Principal, scopes: readonly Scope[], options?: { turn?: McpTurnOptions }): McpServer {
  const server = new McpServer({ name: "bemlembrado", version: "0.0.0" });

  server.registerTool(
    "ping",
    { ...toolMeta("ping"), inputSchema: {} },
    () => ({ content: [{ type: "text" as const, text: "pong" }] }),
  );

  server.registerTool(
    "add_memory",
    {
      ...toolMeta("add_memory"),
      inputSchema: {
        namespace: z.string().describe("Your agent/app namespace label."),
        text: z.string().describe("The memory content to store."),
        kind: z.enum(["semantic", "episodic"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        dedupeKey: z.string().optional().describe("Idempotency key, unique per namespace."),
      },
    },
    async (args) => {
      assertToolScope(scopes, "memory:write");
      return jsonResult(await addMemoryService(deps, principal, args));
    },
  );

  server.registerTool(
    "create_namespace",
    {
      ...toolMeta("create_namespace"),
      inputSchema: {
        namespace: z.string().describe("The namespace label to create. Idempotent — returns the existing one if it already exists."),
        confidential: z
          .boolean()
          .optional()
          .describe(
            "When creating a NEW namespace, mark it confidential (LGPD ACL): reading it then requires a credential with the confidential device claim. Use for sensitive or imported data so it is never born world-readable. Ignored when the namespace already exists.",
          ),
      },
    },
    async (args) => {
      assertToolScope(scopes, "memory:write");
      return jsonResult(await createNamespaceService(deps, principal, args));
    },
  );

  server.registerTool(
    "list_namespaces",
    { ...toolMeta("list_namespaces"), inputSchema: {} },
    async () => {
      assertToolScope(scopes, "memory:read");
      return jsonResult(await listNamespacesService(deps, principal));
    },
  );

  server.registerTool(
    "get_page",
    {
      ...toolMeta("get_page"),
      inputSchema: {
        namespace: z.string().describe("Your agent/app namespace label."),
        limit: z.number().int().optional().describe("Max rows to return (default 50, max 200)."),
      },
    },
    async (args) => {
      assertToolScope(scopes, "memory:read");
      return jsonResult(await getPageService(deps, principal, args));
    },
  );

  server.registerTool(
    "log_decision",
    {
      ...toolMeta("log_decision"),
      inputSchema: {
        namespace: z.string().describe("Your agent/app namespace label."),
        title: z.string().describe("Short decision title."),
        body: z.string().describe("The decision detail."),
        refs: z.array(z.string()).optional().describe("Optional reference ids/links."),
      },
    },
    async (args) => {
      assertToolScope(scopes, "memory:write");
      return jsonResult(await logDecisionService(deps, principal, args));
    },
  );

  const searchInput = { namespace: z.string(), query: z.string(), topK: z.number().int().optional() };
  const searchHandler = async (args: { namespace: string; query: string; topK?: number | undefined }) => {
    assertToolScope(scopes, "memory:read");
    return jsonResult(await searchMemoryService(deps, principal, args)); // { hits, requested, returned, dropped }
  };
  server.registerTool("search_memory", { ...toolMeta("search_memory"), inputSchema: searchInput }, searchHandler);
  // P5 compat alias for the search_second_brain tool name. SAME handler, SAME
  // memory:read gate, SAME principal — one code path, no second endpoint (locked by the
  // identical-payload test in test/mcp/alias-and-devices.test.ts).
  server.registerTool("search_second_brain", { ...toolMeta("search_second_brain"), inputSchema: searchInput }, searchHandler);

  server.registerTool(
    "get_session_context",
    {
      ...toolMeta("get_session_context"),
      inputSchema: {
        sessionId: z.string(),
        allowMidConvSystem: z.boolean().optional(),
      },
    },
    async (args) => {
      assertToolScope(scopes, "session:read");
      return jsonResult(await getSessionContextService(deps, principal, args));
    },
  );

  const turn = options?.turn;
  if (turn !== undefined) {
    server.registerTool(
      "remember_and_respond",
      {
        ...toolMeta("remember_and_respond"),
        inputSchema: {
          sessionId: z.string(),
          namespace: z.string(),
          message: z.string(),
          systemPrompt: z.string().optional(),
          provider: z.enum(["anthropic", "workers-ai", "maritaca"]).optional(),
          lang: z.string().optional(),
          topK: z.number().int().optional(),
        },
      },
      async (args) => {
        assertToolScope(scopes, "memory:write"); // a turn persists the exchange
        // Same validation as REST /v1/turn; principal is the bound tenant.
        const req = parseTurnRequest(args);
        const provider = turn.resolveProvider(req.lang ?? "en", req.provider);
        const result = await runTurn(turn.deps, principal, toRunTurnInput(req, provider));
        return jsonResult({ sessionId: result.sessionId, reply: result.reply, usage: result.usage, provenance: result.provenance });
      },
    );
  }

  return server;
}

/** Hono exposes executionCtx only when the runtime supplies one; tests may not. */
function executionCtxOf(c: Context<AppEnv>): ExecutionContext {
  try {
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  }
}

/** Mount /mcp. Auth (apiKeyAuth on /mcp) is wired by the caller; principal comes from it. */
export function registerMcp(app: Hono<AppEnv>): void {
  app.all(MCP_ROUTE, (c) => {
    const toolDeps = toolCoreDepsFrom(c);
    const { chat } = buildInferenceDeps(c.env);
    const env = c.env;
    const turn: McpTurnOptions = {
      deps: { ...toolDeps, chat },
      resolveProvider: (lang, requested) => resolveChatProvider(env, lang, requested),
    };
    // Scopes from apiKeyAuth (ALL_SCOPES for an API key, the token's subset for a
    // scoped token). Default [] is fail-closed — every gated tool then denies.
    const scopes = c.var.scopes ?? [];
    const server = buildMcpServer(toolDeps, principalOf(c), scopes, { turn });
    return createMcpHandler(server, { route: MCP_ROUTE })(c.req.raw, c.env, executionCtxOf(c));
  });
}
