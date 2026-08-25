import { z } from "zod";

/**
 * R2 vault store — the LLM-Wiki markdown notes layer (PR #41 / vault-A1).
 *
 * R2 markdown is the SOURCE OF TRUTH for notes; D1 mirrors the link graph
 * and Vectorize indexes note chunks for retrieval. Bucket-level object
 * versioning is ON in staging/prod (runbook) so updates are non-destructive and
 * history is preserved (KFM-004).
 *
 * Key layout: `{tenantId}/{namespaceId}/notes/{slug}.md`. Both tenantId AND
 * namespaceId are REQUIRED, non-optional args (INVARIANT #2 — there is no
 * unscoped vault access). Slugs are constrained to kebab-case so a hostile slug
 * can never traverse out of its namespace prefix.
 *
 * Frontmatter is emitted as a JSON-per-line subset that is simultaneously valid
 * YAML (double-quoted strings, bare integers, JSON flow arrays). Parsing is then
 * `JSON.parse` per value — bulletproof — while the file still opens as valid YAML
 * frontmatter in any markdown/Obsidian reader.
 */

export const NOTE_TYPES = ["fact", "entity", "preference", "event", "summary", "note"] as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const frontmatterSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  source_episode: z.string().min(1).optional(),
  links: z.array(z.string().min(1)),
  /** Set when the LLM Council resolved a contested write. */
  consolidated_by: z.literal("council").optional(),
});

export type NoteFrontmatter = z.infer<typeof frontmatterSchema>;

export interface Note {
  readonly slug: string;
  readonly frontmatter: NoteFrontmatter;
  readonly body: string;
}

export interface PutNoteResult {
  readonly key: string;
  /** R2 object version (changes on every put; versioning ON keeps prior versions). */
  readonly version: string;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Serialize a note to a markdown file with valid (JSON-subset) YAML frontmatter. */
export function serializeNote(note: Note): string {
  const fm = note.frontmatter;
  const lines = [
    "---",
    `id: ${JSON.stringify(fm.id)}`,
    `type: ${JSON.stringify(fm.type)}`,
    `created_at: ${String(fm.created_at)}`,
    `updated_at: ${String(fm.updated_at)}`,
    ...(fm.source_episode !== undefined ? [`source_episode: ${JSON.stringify(fm.source_episode)}`] : []),
    ...(fm.consolidated_by !== undefined ? [`consolidated_by: ${JSON.stringify(fm.consolidated_by)}`] : []),
    `links: ${JSON.stringify(fm.links)}`,
    "---",
    note.body,
  ];
  return lines.join("\n");
}

/** Parse a stored markdown file back into a Note (frontmatter schema-validated). */
export function parseNote(slug: string, raw: string): Note {
  const match = FRONTMATTER_RE.exec(raw);
  if (match === null) {
    throw new VaultError(`note ${slug}: missing or malformed frontmatter`);
  }
  const block = match[1] ?? "";
  const body = match[2] ?? "";
  const obj: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) {
      throw new VaultError(`note ${slug}: malformed frontmatter line`);
    }
    const key = line.slice(0, idx).trim();
    try {
      obj[key] = JSON.parse(line.slice(idx + 1).trim());
    } catch {
      throw new VaultError(`note ${slug}: unparseable frontmatter value for "${key}"`);
    }
  }
  const parsed = frontmatterSchema.safeParse(obj);
  if (!parsed.success) {
    throw new VaultError(`note ${slug}: invalid frontmatter (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")})`);
  }
  return { slug, frontmatter: parsed.data, body };
}

/** CRUD over the R2 markdown vault, tenant+namespace scoped. */
export class VaultStore {
  constructor(private readonly bucket: R2Bucket) {}

  private prefix(tenantId: string, namespaceId: string): string {
    if (tenantId.length === 0 || namespaceId.length === 0) {
      throw new VaultError("tenantId and namespaceId are required");
    }
    return `${tenantId}/${namespaceId}/notes/`;
  }

  private key(tenantId: string, namespaceId: string, slug: string): string {
    if (!SLUG_RE.test(slug)) {
      throw new VaultError(`invalid slug: ${JSON.stringify(slug)} (kebab-case [a-z0-9-] required)`);
    }
    return `${this.prefix(tenantId, namespaceId)}${slug}.md`;
  }

  async putNote(tenantId: string, namespaceId: string, note: Note): Promise<PutNoteResult> {
    const key = this.key(tenantId, namespaceId, note.slug);
    // put() without `onlyIf` always resolves to a non-null R2Object.
    const obj = await this.bucket.put(key, serializeNote(note), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { tenant: tenantId, namespace: namespaceId, slug: note.slug, type: note.frontmatter.type },
    });
    return { key, version: obj.version };
  }

  async getNote(tenantId: string, namespaceId: string, slug: string): Promise<Note | null> {
    const obj = await this.bucket.get(this.key(tenantId, namespaceId, slug));
    if (obj === null) return null;
    return parseNote(slug, await obj.text());
  }

  /** List the slugs of every note under the tenant+namespace prefix (paginated). */
  async listNotes(tenantId: string, namespaceId: string): Promise<string[]> {
    const prefix = this.prefix(tenantId, namespaceId);
    const slugs: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.bucket.list({ prefix, ...(cursor !== undefined ? { cursor } : {}) });
      for (const o of res.objects) {
        const name = o.key.slice(prefix.length);
        if (name.endsWith(".md")) slugs.push(name.slice(0, -3));
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor !== undefined);
    return slugs;
  }

  async deleteNote(tenantId: string, namespaceId: string, slug: string): Promise<void> {
    await this.bucket.delete(this.key(tenantId, namespaceId, slug));
  }

  /** The MEMORY.md-style index lives beside (not inside) notes/, so listNotes never picks it up. */
  private indexKey(tenantId: string, namespaceId: string): string {
    if (tenantId.length === 0 || namespaceId.length === 0) {
      throw new VaultError("tenantId and namespaceId are required");
    }
    return `${tenantId}/${namespaceId}/index.md`;
  }

  async putIndex(tenantId: string, namespaceId: string, content: string): Promise<void> {
    await this.bucket.put(this.indexKey(tenantId, namespaceId), content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  }

  async getIndex(tenantId: string, namespaceId: string): Promise<string | null> {
    const obj = await this.bucket.get(this.indexKey(tenantId, namespaceId));
    return obj === null ? null : obj.text();
  }

  /** Right-to-erasure: delete EVERY object under the namespace (notes/ + index.md). */
  async deleteNamespaceObjects(tenantId: string, namespaceId: string): Promise<number> {
    if (tenantId.length === 0 || namespaceId.length === 0) {
      throw new VaultError("tenantId and namespaceId are required");
    }
    const prefix = `${tenantId}/${namespaceId}/`;
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const res = await this.bucket.list({ prefix, ...(cursor !== undefined ? { cursor } : {}) });
      if (res.objects.length > 0) {
        await this.bucket.delete(res.objects.map((o) => o.key));
        deleted += res.objects.length;
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor !== undefined);
    return deleted;
  }
}
