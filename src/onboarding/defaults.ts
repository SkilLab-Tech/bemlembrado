import { EMBED_MODEL } from "../memory/embed";

/**
 * Zero-config defaults (PR #46 / ux-B1). The do-it-all promise: nothing must be
 * configured to start. A tenant gets a "default" namespace, automatic embeddings,
 * and the LLM Council OFF (no spend) unless explicitly enabled.
 */

export const DEFAULT_NAMESPACE_LABEL = "default";

export interface BootstrapDefaults {
  readonly namespaceLabel: string;
  readonly embedModel: string;
  readonly councilEnabled: boolean;
  readonly plan: string;
}

export function bootstrapDefaults(): BootstrapDefaults {
  return {
    namespaceLabel: DEFAULT_NAMESPACE_LABEL,
    embedModel: EMBED_MODEL,
    councilEnabled: false,
    plan: "open",
  };
}
