/**
 * Trusted-context sanitizer (turn-batch, roadmap #78). Retrieved content can be
 * elevated to a mid-conversation SYSTEM message on Opus-4.8 (the trusted placement),
 * where it carries more authority than a fenced tool_result. This neutralizes the
 * structural injection vectors before that elevation — defense-in-depth, NOT a
 * guarantee:
 *   - fence-breakout: a closing </retrieved-memory>/</working-memory> tag inside the
 *     content could end the data fence early and inject trailing instructions.
 *   - model control tokens: <|...|>, <<SYS>>, [INST] spoof chat-template structure.
 *   - role headers at line start (system:/assistant:/...) spoof a turn boundary.
 *
 * KFM-003 still holds: even sanitized, retrieved content is DATA. The tool_result
 * placement (the default, untrusted path) does not need this — it is already fenced
 * and never treated as instructions — but sanitizing everywhere is cheap insurance.
 */

const CONTROL_TOKENS = /<\|[^|>]*\|>|<<\/?SYS>>|\[\/?INST\]/gi;
const FENCE_TAGS = /<\/?(?:retrieved-memory|working-memory)>/gi;
const ROLE_HEADER = /^([ \t]*)(system|assistant|user|tool|developer)[ \t]*:/gim;

export function sanitizeTrustedContext(text: string): string {
  return text
    .replace(CONTROL_TOKENS, " ")
    .replace(FENCE_TAGS, " ")
    .replace(ROLE_HEADER, "$1$2 —")
    .trim();
}
