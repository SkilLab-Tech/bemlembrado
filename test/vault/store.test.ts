import { beforeEach, describe, expect, it } from "vitest";
import { type Note, parseNote, serializeNote, VaultError, VaultStore } from "../../src/vault/store";
import { testEnv } from "../helpers/env";

/**
 * R2 is locally simulated by Miniflare, so the vault store is exercised against a
 * REAL R2 binding in the pool — no fakes (unlike Vectorize/AI).
 */

function note(slug: string, body: string, links: string[] = [], extra: Partial<Note["frontmatter"]> = {}): Note {
  return {
    slug,
    frontmatter: { id: `id-${slug}`, type: "fact", created_at: 1, updated_at: 1, links, ...extra },
    body,
  };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) {
    await testEnv.VAULT.delete(res.objects.map((o) => o.key));
  }
}

describe("vault frontmatter codec", () => {
  it("round-trips through serialize/parse (incl. wikilinks + source_episode)", () => {
    const n = note("pix-pref", "user prefers [[pix]] over [[card]]", ["pix", "card"], { source_episode: "m1" });
    const parsed = parseNote("pix-pref", serializeNote(n));
    expect(parsed).toStrictEqual(n);
  });

  it("emits valid YAML-subset frontmatter", () => {
    const raw = serializeNote(note("n1", "body", ["a", "b"]));
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain('\nid: "id-n1"\n');
    expect(raw).toContain('\nlinks: ["a","b"]\n');
    expect(raw.endsWith("\n---\nbody")).toBe(true);
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseNote("x", "just a body")).toThrow(VaultError);
  });

  it("rejects frontmatter that fails the schema", () => {
    // links must be an array; here it is a bare string.
    const bad = '---\nid: "x"\ntype: "fact"\ncreated_at: 1\nupdated_at: 1\nlinks: "nope"\n---\nbody';
    expect(() => parseNote("x", bad)).toThrow(VaultError);
  });
});

describe("VaultStore (real R2 in pool)", () => {
  let store: VaultStore;

  beforeEach(async () => {
    store = new VaultStore(testEnv.VAULT);
    await clearVault();
  });

  it("round-trips a note to R2 with valid frontmatter + body", async () => {
    const put = await store.putNote("t1", "ns1", note("pix-pref", "user prefers [[pix]]", ["pix"]));
    expect(put.key).toBe("t1/ns1/notes/pix-pref.md");

    const got = await store.getNote("t1", "ns1", "pix-pref");
    expect(got).not.toBeNull();
    expect(got?.frontmatter.id).toBe("id-pix-pref");
    expect(got?.frontmatter.links).toStrictEqual(["pix"]);
    expect(got?.body).toBe("user prefers [[pix]]");
  });

  it("object version changes on update (non-destructive history; KFM-004)", async () => {
    const r1 = await store.putNote("t1", "ns1", note("n1", "v1"));
    const r2 = await store.putNote("t1", "ns1", note("n1", "v2"));
    expect(r1.version).toBeTruthy();
    expect(r2.version).toBeTruthy();
    expect(r2.version).not.toBe(r1.version);
  });

  it("getNote returns null for a missing slug", async () => {
    expect(await store.getNote("t1", "ns1", "nope")).toBeNull();
  });

  it("listNotes is scoped to the tenant+namespace prefix (isolation)", async () => {
    await store.putNote("t1", "ns1", note("alpha", "x"));
    await store.putNote("t1", "ns1", note("beta", "y"));
    await store.putNote("t2", "ns1", note("gamma", "z")); // other tenant
    await store.putNote("t1", "ns2", note("delta", "w")); // other namespace
    expect((await store.listNotes("t1", "ns1")).sort()).toStrictEqual(["alpha", "beta"]);
  });

  it("deleteNote removes only the target note", async () => {
    await store.putNote("t1", "ns1", note("alpha", "x"));
    await store.putNote("t1", "ns1", note("beta", "y"));
    await store.deleteNote("t1", "ns1", "alpha");
    expect(await store.getNote("t1", "ns1", "alpha")).toBeNull();
    expect(await store.getNote("t1", "ns1", "beta")).not.toBeNull();
  });

  it("rejects a slug attempting path traversal", async () => {
    await expect(store.putNote("t1", "ns1", note("../evil", "x"))).rejects.toBeInstanceOf(VaultError);
  });

  it("requires both tenant and namespace", async () => {
    await expect(store.putNote("", "ns1", note("alpha", "x"))).rejects.toBeInstanceOf(VaultError);
    await expect(store.getNote("t1", "", "alpha")).rejects.toBeInstanceOf(VaultError);
  });
});
