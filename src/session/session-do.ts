import { DurableObject } from "cloudflare:workers";
import type { MessageRole } from "../db/client";
import type { Env } from "../env";

/**
 * SessionDO — per-session working memory.
 *
 * One Durable Object per session holds a bounded ring of the most recent messages.
 * Because a DO is single-threaded, its storage operations are serialized — the
 * basis for the no-lost-writes guarantee under concurrency. Class name is
 * LOCKED to `SessionDO` to match the wrangler DO migration (tag v1, sqlite).
 */

export interface WorkingMessage {
  role: MessageRole;
  content: string;
  ts: number;
}

/** Max messages kept in working memory (older ones drop off the ring). */
export const MAX_WORKING_MESSAGES = 50;
const STORAGE_KEY = "messages";

/**
 * DO name = `${namespaceId}:${sessionId}` (P0 #2): a raw cross-tenant sessionId
 * addresses a DIFFERENT (empty) DO, so working memory can never collide across
 * tenants. Write (appendMessage) and read (get_session_context) MUST use this.
 */
export function sessionDoName(namespaceId: string, sessionId: string): string {
  return `${namespaceId}:${sessionId}`;
}

/** The single place that resolves a SessionDO stub from (namespace, session). */
export function sessionStub(
  sessions: DurableObjectNamespace<SessionDO>,
  namespaceId: string,
  sessionId: string,
): DurableObjectStub<SessionDO> {
  return sessions.get(sessions.idFromName(sessionDoName(namespaceId, sessionId)));
}

export class SessionDO extends DurableObject<Env> {
  async append(message: WorkingMessage): Promise<void> {
    const messages = (await this.ctx.storage.get<WorkingMessage[]>(STORAGE_KEY)) ?? [];
    messages.push(message);
    const trimmed = messages.length > MAX_WORKING_MESSAGES ? messages.slice(messages.length - MAX_WORKING_MESSAGES) : messages;
    await this.ctx.storage.put(STORAGE_KEY, trimmed);
  }

  async getWorkingMemory(): Promise<WorkingMessage[]> {
    return (await this.ctx.storage.get<WorkingMessage[]>(STORAGE_KEY)) ?? [];
  }

  async size(): Promise<number> {
    return (await this.ctx.storage.get<WorkingMessage[]>(STORAGE_KEY))?.length ?? 0;
  }

  async clear(): Promise<void> {
    await this.ctx.storage.delete(STORAGE_KEY);
  }
}
