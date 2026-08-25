/**
 * Facts about the DEPLOYED remote MCP server, used to build the registry `server.json`.
 * Plain data, ZERO imports — this module must be safe to reference from anywhere. The
 * committed `server.json` is generated from these facts; change a host/version here and
 * regenerate server.json to match.
 */
export const BEMLEMBRADO_SERVER_FACTS = {
  name: "io.github.skillab-tech/bemlembrado", // reverse-DNS; repo org = SkilLab-Tech
  title: "BemLembrado",
  description: "Cache-aware, edge-native agent memory on Cloudflare: semantic search, capture, and a session Context Block designed to sit after the prompt-cache breakpoint.",
  version: "0.1.0", // registry release, bumped BY HAND (not the worker version)
  url: "https://api.bemlembrado.com/mcp", // wrangler.jsonc production custom domain + MCP_ROUTE
  repository: { url: "https://github.com/SkilLab-Tech/bemlembrado", source: "github" as const },
  headers: [
    {
      name: "Authorization",
      description: "Bearer <token>: a BemLembrado scoped device token (blt_) or the tenant API key (bl_).",
      isRequired: true,
      isSecret: true,
    },
  ],
};
