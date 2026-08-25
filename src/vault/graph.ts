import type { Db, NoteLinkRow } from "../db/client";

/**
 * LLM-Wiki link graph (PR #42 / vault-A2). The R2 vault holds the markdown
 * (source of truth); this module keeps the D1 mirror — note metadata + the
 * directed `[[wikilink]]` edge graph — in sync so backlinks, traversal and
 * orphan-detection are cheap. All operations are namespace-scoped (INVARIANT #2).
 */

/** Match `[[slug]]` wikilinks where slug is kebab-case (mirrors the vault slug rule). */
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

/** Extract the unique, ordered set of `[[slug]]` targets referenced in a note body. */
export function parseLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(LINK_RE)) {
    const slug = match[1];
    if (slug !== undefined) seen.add(slug);
  }
  return [...seen];
}

export interface NoteMirror {
  id: string;
  slug: string;
  type: string;
  r2Key: string;
  createdAt: number;
  updatedAt: number;
}

export class NoteGraph {
  constructor(private readonly db: Db) {}

  /** Mirror a note row + replace its outbound edges parsed from the body. */
  async indexNote(namespaceId: string, note: NoteMirror, body: string): Promise<string[]> {
    await this.db.upsertNote({
      id: note.id,
      namespace_id: namespaceId,
      slug: note.slug,
      type: note.type,
      r2_key: note.r2Key,
      created_at: note.createdAt,
      updated_at: note.updatedAt,
    });
    const links = parseLinks(body);
    await this.db.replaceNoteLinks(namespaceId, note.slug, links);
    return links;
  }

  async removeNote(namespaceId: string, slug: string): Promise<void> {
    await this.db.deleteNoteBySlug(namespaceId, slug);
  }

  /** Slugs of notes that link TO the given slug. */
  backlinks(namespaceId: string, slug: string): Promise<string[]> {
    return this.db.getBacklinks(namespaceId, slug);
  }

  outboundLinks(namespaceId: string, slug: string): Promise<string[]> {
    return this.db.getOutboundLinks(namespaceId, slug);
  }

  /** Edges pointing at notes that do not (yet) exist — surfaced, never rejected. */
  orphanLinks(namespaceId: string): Promise<NoteLinkRow[]> {
    return this.db.listOrphanLinks(namespaceId);
  }
}
