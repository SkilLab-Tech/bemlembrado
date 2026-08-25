import type { Context, Hono } from "hono";
import { createLogger } from "../obs/log";
import type { AppEnv } from "./app";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "forbidden"
  | "internal";

/** HTTP statuses we emit (a subset of Hono's ContentfulStatusCode). */
export type ErrorStatus = 400 | 401 | 403 | 404 | 429 | 500;

export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly request_id: string | null;
  };
}

/** Base for all expected/handled errors. Carries a stable machine code + status. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: ErrorStatus;
  constructor(code: ErrorCode, httpStatus: ErrorStatus, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class BadRequest extends AppError {
  constructor(message = "bad request") {
    super("bad_request", 400, message);
  }
}
export class Unauthorized extends AppError {
  constructor(message = "unauthorized") {
    super("unauthorized", 401, message);
  }
}
export class NotFound extends AppError {
  constructor(message = "not found") {
    super("not_found", 404, message);
  }
}
export class RateLimited extends AppError {
  constructor(message = "rate limited") {
    super("rate_limited", 429, message);
  }
}
export class QuotaExceeded extends AppError {
  constructor(message = "quota exceeded") {
    super("quota_exceeded", 403, message);
  }
}
export class Forbidden extends AppError {
  constructor(message = "forbidden") {
    super("forbidden", 403, message);
  }
}
export class Internal extends AppError {
  constructor(message = "internal error") {
    super("internal", 500, message);
  }
}

function requestId(c: Context<AppEnv>): string | null {
  return c.get("requestId") ?? null;
}

function envelope(code: ErrorCode, message: string, c: Context<AppEnv>): ErrorBody {
  return { error: { code, message, request_id: requestId(c) } };
}

/** Register global notFound + onError handlers that render the stable envelope. */
export function registerErrors(app: Hono<AppEnv>): void {
  app.notFound((c) => c.json(envelope("not_found", "not found", c), 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      // 4xx are normal client errors; only 5xx AppErrors are worth a server-side line.
      if (err.httpStatus >= 500) {
        createLogger().log("error", "app_error", { request_id: requestId(c), code: err.code, name: err.name, error: err.message });
      }
      return c.json(envelope(err.code, err.message, c), err.httpStatus);
    }
    // Unknown throwable -> opaque 500 to the CLIENT (never serialize message/stack),
    // but LOG name+message+stack server-side so the real cause (e.g. an inference
    // binding failure) is visible in `wrangler tail` instead of being swallowed.
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "unknown error");
    createLogger().log("error", "unhandled", { request_id: requestId(c), name: e.name, error: e.message, stack: e.stack });
    return c.json(envelope("internal", "internal error", c), 500);
  });
}
