// Agreement library against a hand-built database, and the editor's geometry rules.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampToPage, overlappingFields, type Field } from "../lib/fields";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-lib-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

describe("agreement library", () => {
  let L: typeof import("../lib/library");
  let db: typeof import("../lib/db");
  const at = (d: number) => new Date(Date.parse("2026-11-01T12:00:00Z") + d * 86400_000).toISOString();

  function workspace(id: string) {
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id, `Firm ${id}`, `Firm ${id} LLC`, `Firm ${id}`, "Avery Tester", `avery-${id}@example.com`, `inb_${id}`, at(0),
    );
  }
  function template(id: string, ws: string, name: string, opts: { live?: string; def?: boolean; archived?: boolean; day: number }) {
    db.run("INSERT INTO templates (id, workspace_id, name, active_version_id, is_default, archived, created_at) VALUES (?,?,?,?,?,?,?)", id, ws, name, opts.live ?? null, opts.def ? 1 : 0, opts.archived ? 1 : 0, at(opts.day));
  }
  function version(id: string, ws: string, tpl: string, n: number, status: "draft" | "published", source = "agreement.pdf") {
    db.run(
      "INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, tpl, ws, n, source, "x", "x", "0", "[]", "[]", "{}", status, at(n), status === "published" ? at(n) : null,
    );
  }
  let k = 0;
  function files(ws: string, tv: string, count: number) {
    for (let i = 0; i < count; i++)
      db.run(
        "INSERT INTO files (id, workspace_id, template_version_id, title, client_name, client_email, status, token_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        `file_${++k}`, ws, tv, "t", "Jordan Sample", "jordan@example.com", "completed", `h${k}`, at(5),
      );
  }

  beforeAll(async () => {
    db = await import("../lib/db");
    L = await import("../lib/library");
    workspace("ws_a");
    workspace("ws_b");
    // A: an MSA with three versions (v2 live, v3 draft), a draft-only letter, an archived NDA
    template("tpl_msa", "ws_a", "Master Services Agreement", { live: "tv_m2", def: true, day: 1 });
    version("tv_m1", "ws_a", "tpl_msa", 1, "published", "msa-2025.pdf");
    version("tv_m2", "ws_a", "tpl_msa", 2, "published", "msa-2026.pdf");
    version("tv_m3", "ws_a", "tpl_msa", 3, "draft", "msa-2026.pdf");
    files("ws_a", "tv_m1", 4);
    files("ws_a", "tv_m2", 2);
    template("tpl_letter", "ws_a", "Engagement Letter", { day: 2 });
    version("tv_l1", "ws_a", "tpl_letter", 1, "draft", "engagement.docx");
    template("tpl_nda", "ws_a", "Mutual NDA", { live: "tv_n1", archived: true, day: 3 });
    version("tv_n1", "ws_a", "tpl_nda", 1, "published");
    files("ws_a", "tv_n1", 1);
    // B: its own agreement and files, which A must never count
    template("tpl_b", "ws_b", "Master Services Agreement", { live: "tv_b1", day: 1 });
    version("tv_b1", "ws_b", "tpl_b", 1, "published");
    files("ws_b", "tv_b1", 9);
  });

  it("gives each agreement its real state, live version, draft and history", () => {
    const lib = L.agreementLibrary("ws_a");
    expect(lib.map((a) => [a.name, a.state])).toEqual([
      ["Master Services Agreement", "live"],
      ["Engagement Letter", "draft"],
      ["Mutual NDA", "archived"],
    ]);
    const msa = lib[0];
    expect(msa.isDefault).toBe(true);
    expect(msa.liveVersion?.version).toBe(2);
    expect(msa.draft?.version).toBe(3);
    expect(msa.versions.map((v) => [v.version, v.status, v.live, v.files])).toEqual([
      [3, "draft", false, 0],
      [2, "published", true, 2],
      [1, "published", false, 4],
    ]);
    expect(msa.files).toBe(6);
    expect(lib[1].liveVersion).toBeNull();
  });

  it("counts only this workspace's files and agreements", () => {
    const a = L.agreementLibrary("ws_a");
    const b = L.agreementLibrary("ws_b");
    expect(a.flatMap((x) => x.versions.map((v) => v.id))).not.toContain("tv_b1");
    expect(b).toHaveLength(1);
    expect(b[0].files).toBe(9);
    expect(b[0].versions.map((v) => v.id)).toEqual(["tv_b1"]);
    expect(L.agreementLibrary("ws_nobody")).toEqual([]);
  });

  it("filters by tab and search, and counts tabs", () => {
    const lib = L.agreementLibrary("ws_a");
    const names = (v: import("../lib/library").LibraryView, q = "") => L.filterLibrary(lib, v, q).map((a) => a.name);
    expect(names("all")).toEqual(["Master Services Agreement", "Engagement Letter"]);
    expect(names("live")).toEqual(["Master Services Agreement"]);
    expect(names("draft")).toEqual(["Master Services Agreement", "Engagement Letter"]);
    expect(names("archived")).toEqual(["Mutual NDA"]);
    expect(names("all", "  engagement ")).toEqual(["Engagement Letter"]);
    expect(names("all", "msa-2025")).toEqual(["Master Services Agreement"]);
    expect(names("all", "nda")).toEqual([]);
    expect(L.libraryCounts(lib)).toEqual({ all: 2, live: 1, draft: 2, archived: 1 });
  });
});

describe("field geometry", () => {
  const page = { width: 612, height: 792 };
  const f = (p: Partial<Field>): Field => ({ id: "f1", type: "signature", role: "client", page: 0, x: 100, y: 100, w: 180, h: 30, label: "Signature", required: true, ...p });

  it("keeps a field on its page", () => {
    expect(clampToPage(f({ x: -40, y: -5 }), page)).toMatchObject({ x: 0, y: 0, w: 180, h: 30 });
    expect(clampToPage(f({ x: 600, y: 790 }), page)).toMatchObject({ x: 432, y: 762 });
    expect(clampToPage(f({ w: 9000, h: 2 }), page)).toMatchObject({ x: 0, w: 612, h: 6 });
    const inside = f({ x: 50, y: 60 });
    expect(clampToPage(inside, page)).toEqual(inside);
  });

  it("flags fields that cover each other, not ones that just touch", () => {
    const sig = f({ id: "a" });
    expect(overlappingFields([sig, f({ id: "b", y: 130, h: 15 })])).toHaveLength(0); // name line right under
    expect(overlappingFields([sig, f({ id: "b", x: 110, y: 105 })]).map(([a, b]) => [a.id, b.id])).toEqual([["a", "b"]]);
    expect(overlappingFields([sig, f({ id: "b", page: 1 })])).toHaveLength(0);
    expect(overlappingFields([sig, f({ id: "b", x: 270, w: 100 })])).toHaveLength(0); // 10pt sliver
  });
});
