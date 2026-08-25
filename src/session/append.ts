import type { Db, MessageRole } from "../db/client";
import { type SessionDO, sessionStub } from "./session-do";

/**
 * appendMessage: the write path for conversation turns.
 * Persists to D1 MESSAGE (source of truth) and mirrors into the SessionDO working
 * memory. Because the DO is single-threaded with storage input-gates, N concurrent
 * appends to the same session serialize — no lost writes.
 */

export interface AppendMessageDeps {
  db: Db;
  sessions: DurableObjectNamespace<SessionDO>;
}

export interface AppendMessageInput {
  sessionId: string;
  namespaceId: string;
  role: MessageRole;
  content: string;
  ts: number;
  /** Message id; defaults to a fresh UUID. */
  id?: string;
}

export async function appendMessage(deps: AppendMessageDeps, input: AppendMessageInput): Promise<string> {
  // Ensure the D1 session row exists (FK target for the message); race-safe.
  await deps.db.insertSessionIfAbsent({ id: input.sessionId, namespace_id: input.namespaceId, started_at: input.ts });

  const id = input.id ?? crypto.randomUUID();
  await deps.db.insertMessage({
    id,
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    token_count: null,
    created_at: input.ts,
  });

  // Mirror into the per-session DO working memory (serialized by the DO).
  // Keyed by ${namespaceId}:${sessionId} so working memory is tenant-isolated (P0 #2).
  const stub = sessionStub(deps.sessions, input.namespaceId, input.sessionId);
  await stub.append({ role: input.role, content: input.content, ts: input.ts });

  return id;
}
