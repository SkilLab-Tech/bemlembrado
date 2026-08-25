import { type BootstrapDefaults, bootstrapDefaults } from "./defaults";

/**
 * One-line onboarding payload (PR #46 / ux-B1): given the request origin, return
 * the single MCP connect string + REST base + the zero-config defaults. The raw
 * API key is NEVER known server-side (only its hash is stored), so the connect
 * config carries a <YOUR_API_KEY> placeholder the caller fills with the key they
 * created — there is nothing else to configure.
 */

export interface OnboardingInfo {
  readonly namespace: string;
  readonly defaults: BootstrapDefaults;
  readonly mcp: {
    readonly transport: "streamable-http";
    readonly url: string;
    readonly config: { mcpServers: { bemlembrado: { url: string; headers: { Authorization: string } } } };
  };
  readonly rest: { readonly base: string };
}

export function buildOnboarding(origin: string, namespaceLabel?: string): OnboardingInfo {
  const defaults = bootstrapDefaults();
  const mcpUrl = `${origin}/mcp`;
  return {
    namespace: namespaceLabel ?? defaults.namespaceLabel,
    defaults,
    mcp: {
      transport: "streamable-http",
      url: mcpUrl,
      config: { mcpServers: { bemlembrado: { url: mcpUrl, headers: { Authorization: "Bearer <YOUR_API_KEY>" } } } },
    },
    rest: { base: `${origin}/v1` },
  };
}
