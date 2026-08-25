/**
 * Structured JSON logger with secret/PII redaction.
 *
 * The sink is injectable so tests can capture output and production can swap in
 * a different transport. Redaction is recursive over object fields. This is the
 * single logging seam later phases (usage telemetry, DO writes) reuse.
 */

const REDACT_KEYS: ReadonlySet<string> = new Set([
  "api_key",
  "apikey",
  "pepper",
  "api_key_pepper",
  "authorization",
  "cache_control",
  "anthropic_api_key",
  "cloudflare_api_token",
  "maritaca_api_key",
  "cpf",
  "email",
  "password",
  "secret",
]);

// Suffix/word match so new secret fields (x_api_key, *_token, MARITACA_API_KEY, …) are
// redacted without an explicit allowlist entry. Word-boundaried to avoid eating "monkey".
const REDACT_SUFFIX = /(?:^|_)(?:api[_-]?key|key|token|secret|pepper|password|authorization|bearer)$/;
const REDACT_SUBSTR = ["maritaca", "anthropic_api", "cloudflare_api", "_token", "_secret"];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (REDACT_KEYS.has(k)) return true;
  if (REDACT_SUFFIX.test(k)) return true;
  return REDACT_SUBSTR.some((s) => k.includes(s));
}

const REDACTED = "[redacted]";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as LogFields);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  console.log(line);
};

export function createLogger(sink: LogSink = defaultSink): Logger {
  return {
    log(level, message, fields = {}) {
      const entry = { level, message, ...redact(fields) };
      sink(JSON.stringify(entry));
    },
  };
}
