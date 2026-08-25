import { beforeEach, describe, expect, it } from "vitest";
import { NoteGraph, parseLinks } from "../../src/vault/graph";
import type { NoteMirror } from "../../src/vault/graph";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

function mirror(slug: string, over: Partial<NoteMirror> = {}): NoteMirror {
  return { id: `id-${slug}`, slug, type: "fact", r2Key: `t1/n1/notes/${slug}.md`, createdAt: 1, updatedAt: 1, ...over };
}

describe("parseLinks", () => {
  it("extracts unique kebab-case [[wikilinks]] in order", () => {
    expect(parseLinks("see [[pix]] and [[boleto]] and [[pix]] again")).toStrictEqual(["pix", "boleto"]);
  });
  it("ignores malformed link syntax", () => {
    expect(parseLinks("[[Not Valid]] [[UPPER]] [[ok-one]] [[]]")).toStrictEqual(["ok-one"]);
  });
});

describe("NoteGraph (D1 link mirror)", () => {
  let graph: NoteGraph;

  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t1", "agent-b");
    await seedNamespace("nx", "t2", "agent-a");
    graph = new NoteGraph(db());
  });

  it("backlinks resolve all notes linking to a target", async () => {
    await graph.indexNote("n1", mirror("a"), "links to [[c]]");
    await graph.indexNote("n1", mirror("b"), "also links to [[c]]");
    await graph.indexNote("n1", mirror("c"), "the target");
    expect(await graph.backlinks("n1", "c")).toStrictEqual(["a", "b"]);
    expect(await graph.outboundLinks("n1", "a")).toStrictEqual(["c"]);
  });

  it("flags orphan links (edge to a non-existent note)", async () => {
    await graph.indexNote("n1", mirror("a"), "points at [[ghost]] and [[real]]");
    await graph.indexNote("n1", mirror("real"), "exists");
    expect(await graph.orphanLinks("n1")).toStrictEqual([{ from_slug: "a", to_slug: "ghost" }]);
  });

  it("upsert keeps id+created_at, updates type/r2_key/updated_at and replaces edges", async () => {
    await graph.indexNote("n1", mirror("a"), "links [[x]]");
    await graph.indexNote("n1", mirror("a", { type: "summary", r2Key: "new-key", createdAt: 999, updatedAt: 2 }), "links [[y]]");
    const row = await db().getNoteBySlug("n1", "a");
    expect(row?.id).toBe("id-a");
    expect(row?.created_at).toBe(1); // unchanged on conflict
    expect(row?.type).toBe("summary");
    expect(row?.r2_key).toBe("new-key");
    expect(row?.updated_at).toBe(2);
    expect(await graph.outboundLinks("n1", "a")).toStrictEqual(["y"]); // old [[x]] edge replaced
  });

  it("graph is namespace-isolated (INVARIANT #2)", async () => {
    await graph.indexNote("n1", mirror("a", { id: "n1-a" }), "links [[shared]]");
    await graph.indexNote("n2", mirror("a", { id: "n2-a" }), "links [[shared]]"); // same slug, different namespace (t1)
    await graph.indexNote("nx", mirror("a", { id: "nx-a" }), "links [[shared]]"); // different tenant
    expect(await graph.backlinks("n1", "shared")).toStrictEqual(["a"]);
    expect((await graph.orphanLinks("n2")).length).toBe(1);
    // n1's view never bleeds n2/nx edges:
    expect((await graph.orphanLinks("n1")).length).toBe(1);
  });

  it("removeNote deletes the note and its outbound edges", async () => {
    await graph.indexNote("n1", mirror("a"), "links [[b]]");
    await graph.removeNote("n1", "a");
    expect(await db().getNoteBySlug("n1", "a")).toBeNull();
    expect(await graph.outboundLinks("n1", "a")).toStrictEqual([]);
  });

  it("deleting a namespace cascades the note graph (right-to-erasure foundation)", async () => {
    await graph.indexNote("n1", mirror("a"), "links [[b]]");
    await testEnv.DB.prepare("DELETE FROM namespace WHERE id = ?").bind("n1").run();
    expect(await db().getNoteBySlug("n1", "a")).toBeNull();
    expect(await graph.backlinks("n1", "b")).toStrictEqual([]);
  });
});
