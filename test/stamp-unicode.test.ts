// A signed contract must never show a different name than the one signed. The stamps and the certificate use the
// standard (WinAnsi) fonts: what they can print must print exactly, and anything else must be refused where it is
// entered, and by stamping itself as a last line of defence, never printed altered or as "?".
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Field } from "../lib/fields";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-stamp-unicode-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

type Sess = { userId: string; userName: string; userEmail: string; workspaceId: string; role: "owner" | "admin" | "staff" };
const admin: Sess = { userId: "u_su", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_su", role: "owner" };
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../lib/auth")>()),
  getSession: async () => admin,
  requireSession: async () => admin,
  requireAdmin: async () => admin,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const REFUSED = /has (?:a character|characters) the signed PDF can't print exactly \((.+)\)\. Use the .+ as it should appear, with letters from Western European alphabets\./;

// Names the standard fonts print: Latin-1 letters, and the Windows-1252 extras (€, Š, Ž, Œ, curly quotes, dashes)
const PRINTABLE = ["José Núñez-Müller", "Zoë Ångström", "Straße & Söhne GmbH", "Šárka Žižková", "Œuvre “Les Amis” — O’Brien – 1.200 €", "Ñandú £5 ¿qué? ß"];
// Names they can't: the old winAnsi printed these as "Dvorak", "?ukasz", "Erd?s", "??" and "Zo??" instead
const UNPRINTABLE: [string, string][] = [
  ["Antonín Dvořák", "ř"],
  ["Łukasz Nowak", "Ł"],
  ["Pál Erdős", "ő"],
  ["山田太郎", "山, 田, 太, 郎"],
  ["Zoe 😀", "😀"],
];

async function textOf(pdf: Uint8Array) {
  const { extractPdf } = await import("../lib/pdf/extract");
  const ex = await extractPdf(pdf);
  return ex.pages.map((p) => p.items.map((i) => i.str).join(" ")).join("\n");
}

describe("what the PDF prints", () => {
  it("keeps every WinAnsi character exactly (the old winAnsi folded quotes and dashes, dropped carons and printed € as ?)", async () => {
    const { printForPdf, printProblem } = await import("../lib/pdf/printable");
    for (const s of PRINTABLE) {
      expect(printForPdf(s), s).toEqual({ text: s, bad: [] });
      expect(printProblem(s)).toBeNull();
    }
  });

  it("prints typographic characters outside WinAnsi as the equivalent the document renderer uses", async () => {
    const { printForPdf } = await import("../lib/pdf/printable");
    const { pdfEquivalents } = await import("../lib/m23/doc-output/pdf-text");
    const s = "Smith‐Jones − 10 000";
    expect(printForPdf(s)).toEqual({ text: pdfEquivalents(s), bad: [] });
    expect(printForPdf("José").text, "canonically the same text").toBe("José");
  });

  it("refuses anything else, naming the characters", async () => {
    const { printProblem } = await import("../lib/pdf/printable");
    for (const [s, chars] of UNPRINTABLE) expect(printProblem(s), s).toMatch(new RegExp(`\\(${chars}\\)`));
    expect(printProblem("Antonín Dvořák")).toBe(
      "This name has a character the signed PDF can't print exactly (ř). Use the name as it should appear, with letters from Western European alphabets.",
    );
    expect(printProblem("a\u0007b"), "a control character is named by code point").toMatch(/\(U\+0007\)/);
  });
});

describe("stamping", () => {
  const field = (id: string, y: number): Field => ({ id, type: "text", role: "client", page: 0, x: 72, y, w: 400, h: 18, label: id, required: false });
  let blank: Uint8Array;
  beforeAll(async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    blank = await doc.save();
  });

  it("prints Latin-1 and Windows-1252 names exactly (read back from the stamped PDF)", async () => {
    const { stampFields } = await import("../lib/pdf/stamp");
    const fields = PRINTABLE.map((_, i) => field(`f${i}`, 100 + i * 30));
    const out = await stampFields(blank, fields, new Map(PRINTABLE.map((t, i) => [`f${i}`, { kind: "text" as const, text: t }])));
    const text = await textOf(out);
    for (const s of PRINTABLE) expect(text, s).toContain(s);
  });

  it("throws instead of printing an altered name", async () => {
    const { stampFields, StampTextError } = await import("../lib/pdf/stamp");
    for (const [s, chars] of UNPRINTABLE) {
      const p = stampFields(blank, [field("f", 100)], new Map([["f", { kind: "text" as const, text: s }]]));
      await expect(p, s).rejects.toBeInstanceOf(StampTextError);
      await expect(stampFields(blank, [field("f", 100)], new Map([["f", { kind: "text" as const, text: s }]]))).rejects.toThrow(`(${chars})`);
    }
  });

  it("the certificate prints names exactly, and refuses one it can't", async () => {
    const { appendCertificate, StampTextError } = await import("../lib/pdf/stamp");
    const info = (name: string) => ({
      envelopeId: "file_x",
      documentName: `Engagement letter (version 1), client ${name}`,
      firmName: "Müller & Søn Advokater",
      originalSha256: "a".repeat(64),
      clientSignedSha256: "b".repeat(64),
      parties: [{ role: "Client", name, email: "client@example.com", signedAt: "2026-11-10 12:00:00 UTC" }],
      events: [],
      verifyUrl: "http://localhost:3000/verify",
    });
    const text = await textOf(await appendCertificate(blank, info("Zoë Ångström")));
    expect(text).toContain("Client: Zoë Ångström");
    expect(text).toContain("Sent by: Müller & Søn Advokater");
    await expect(appendCertificate(blank, info("Łukasz Nowak"))).rejects.toBeInstanceOf(StampTextError);
  });
});

describe("refused where it is entered", () => {
  let files: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let actions: typeof import("../app/actions");
  let templateId = "";
  const fields: Field[] = [
    { id: "sig", type: "signature", role: "client", page: 0, x: 72, y: 700, w: 180, h: 24, label: "Signature", required: true },
    { id: "nm", type: "name", role: "client", page: 0, x: 72, y: 650, w: 220, h: 20, label: "Name", required: true },
    { id: "co", type: "company", role: "client", page: 0, x: 72, y: 620, w: 220, h: 20, label: "Company", required: false },
    { id: "fnm", type: "name", role: "firm", page: 0, x: 320, y: 650, w: 220, h: 20, label: "Firm name", required: false },
    { id: "fco", type: "company", role: "firm", page: 0, x: 320, y: 620, w: 220, h: 20, label: "Firm", required: false },
  ];
  const ws = () => files.getWorkspace(admin.workspaceId);
  const newFile = (over: Partial<import("../lib/files").NewFile> = {}) =>
    files.createFile(ws(), { templateId, clientName: "Zoë Ångström", clientEmail: "zoe@example.com", ...over }, { kind: "system", label: "test" }, {});
  const tokenOf = (f: import("../lib/types").FileRow) => new URL(files.signingLink(f)!).pathname.split("/").pop()!;
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    tpl = await import("../lib/templates");
    actions = await import("../app/actions");
    const t = new Date().toISOString();
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      admin.workspaceId, "Müller", "Müller & Søn Advokater", "Müller", "Avery Tester", "avery@example.com", "inb_su", t,
    );
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", admin.userId, admin.userEmail, admin.userName, "x", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", admin.workspaceId, admin.userId, admin.role, t);
    const { template, version } = await tpl.ingestAgreement(ws(), { data: fs.readFileSync("public/samples/sample-client-agreement.pdf"), filename: "sample.pdf" }, { actor: "test" });
    db.run("UPDATE template_versions SET fields_json = ? WHERE id = ?", JSON.stringify(fields), version.id);
    tpl.publishVersion(ws().id, version.id, "test");
    templateId = template.id;
  });

  it("signs and countersigns Latin-1 names exactly", async () => {
    const f = await newFile();
    const done = await files.completeClientSigning(tokenOf(f), { consent: true, values: { nm: "Zoë Ångström", co: "Straße & Söhne GmbH" }, signature: PNG, method: "typed" }, {});
    const final = done.status === "completed" ? done : await files.countersign(done, ws(), { kind: "user", label: admin.userEmail }, {});
    expect(final.status).toBe("completed");
    const doc = db.one<{ path: string }>("SELECT path FROM documents WHERE file_id = ? AND kind = 'final'", f.id)!;
    const { getBlob } = await import("../lib/storage");
    const text = await textOf(new Uint8Array(await getBlob(doc.path)));
    for (const s of ["Zoë Ångström", "Straße & Söhne GmbH", "Müller & Søn Advokater", "Client: Zoë Ångström"]) expect(text, s).toContain(s);
  });

  it("the signer typing a name the PDF can't print, in the signing room and on the server; nothing is signed", async () => {
    const { fieldError } = await import("../lib/sign-fields");
    const f = await newFile();
    for (const [s, chars] of UNPRINTABLE) {
      expect(fieldError(fields[1], s), s).toMatch(new RegExp(`^This name ${REFUSED.source}`));
      await expect(files.completeClientSigning(tokenOf(f), { consent: true, values: { nm: s }, signature: PNG, method: "typed" }, {}), s).rejects.toThrow(`(${chars})`);
    }
    await expect(files.completeClientSigning(tokenOf(f), { consent: true, values: { nm: "Zoë Ångström", co: "Łowicz Sp. z o.o." }, signature: PNG, method: "typed" }, {})).rejects.toThrow(
      `"Company" has a character the signed PDF can't print exactly (Ł). Use the text as it should appear, with letters from Western European alphabets.`,
    );
    expect(files.getFile(ws().id, f.id).status).not.toBe("signed");
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE file_id = ?", f.id)!.n).toBe(0);
  });

  it("a client name, company, reference, title or stamped prefill value entering a file", async () => {
    const before = db.one<{ n: number }>("SELECT COUNT(*) n FROM files")!.n;
    await expect(newFile({ clientName: "Antonín Dvořák" })).rejects.toThrow(
      "The client name has a character the signed PDF can't print exactly (ř). Use the name as it should appear, with letters from Western European alphabets.",
    );
    await expect(newFile({ clientName: "山田太郎" })).rejects.toThrow(REFUSED);
    await expect(newFile({ clientCompany: "Zoe 😀 Ltd" })).rejects.toThrow(/The client company .*\(😀\)/);
    await expect(newFile({ ref: "Ł-1" })).rejects.toThrow(/The file reference .*\(Ł\)/);
    await expect(newFile({ title: "Erdős engagement" })).rejects.toThrow(/The file title .*\(ő\)/);
    // the public API and CSV import go through the same schema and createFile
    const { NewFileBody } = await import("../lib/schemas");
    const b = NewFileBody.parse({ agreement_id: templateId, client_name: "Łukasz Nowak", client_email: "l@example.com", send: false });
    await expect(files.createFile(ws(), b, { kind: "api", label: 'API key "x"' }, {}, false)).rejects.toThrow(/\(Ł\)/);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM files")!.n, "no file was created").toBe(before);
  });

  it("the workspace legal name and countersigner in settings", async () => {
    const base = { name: "Müller", legal_name: "Müller & Søn Advokater", sender_name: "Müller", reply_to: "", brand_color: "#1f4fd1", countersigner_name: "Avery Tester", countersigner_title: "", countersigner_email: "", reminder_days: "2,5", expiry_days: "14" };
    const r1 = await actions.settingsAction(undefined, form({ ...base, legal_name: "Dvořák & Partners s.r.o." }));
    expect(r1?.error).toBe("Your firm's legal name has a character the signed PDF can't print exactly (ř). Use the name as it should appear, with letters from Western European alphabets.");
    const r2 = await actions.settingsAction(undefined, form({ ...base, countersigner_name: "Łukasz Nowak" }));
    expect(r2?.error).toMatch(/^The countersigner's name .*\(Ł\)/);
    expect(ws().legal_name).toBe("Müller & Søn Advokater");
    expect(ws().countersigner_name).toBe("Avery Tester");
    const ok = await actions.settingsAction(undefined, form({ ...base, countersigner_name: "José Núñez" }));
    expect(ok?.error).toBeUndefined();
    expect(ws().countersigner_name).toBe("José Núñez");
  });

  it("the countersigner adopting a signature", async () => {
    const { POST } = await import("../app/api/settings/signature/route");
    const post = (body: object) => POST(new Request("http://localhost:3000/api/settings/signature", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const r = await post({ signature: PNG, name: "Pál Erdős" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe("This name has a character the signed PDF can't print exactly (ő). Use the name as it should appear, with letters from Western European alphabets.");
    expect(ws().countersigner_name).toBe("José Núñez");
  });

  it("signup and agreement and API key names (printed on the certificate)", async () => {
    const r = await actions.signupAction(undefined, form({ name: "Zoë", email: "new@example.com", password: "long-enough-pw", firm: "Łowicz Legal" }));
    expect(r?.error).toMatch(/^Your firm's name .*\(Ł\)/);
    expect(db.one("SELECT 1 FROM users WHERE email = 'new@example.com'")).toBeUndefined();
    const rn = await actions.templateAction(undefined, form({ templateId, op: "rename", name: "Umowa 山" }));
    expect(rn?.error).toMatch(/^The agreement name .*\(山\)/);
    await expect(tpl.ingestAgreement(ws(), { data: fs.readFileSync("public/samples/sample-client-agreement.pdf"), filename: "x.pdf" }, { actor: "test", name: "Umowa Łowicz" })).rejects.toThrow(/^The agreement name .*\(Ł\)/);
    const k = await actions.apiKeyAction(undefined, form({ name: "CRM 😀" }));
    expect(k?.error).toMatch(/^The key name .*\(😀\)/);
  });

  it("stamping refuses older data that predates these checks: a safe error, and nothing is signed or saved", async () => {
    const f = await newFile();
    db.run("UPDATE files SET client_name = ? WHERE id = ?", "Antonín Dvořák", f.id); // as if saved before the check
    db.run("UPDATE template_versions SET fields_json = ? WHERE template_id = ?", JSON.stringify([...fields, { id: "pre", type: "name", role: "prefill", prefillKey: "client.name", page: 0, x: 72, y: 560, w: 220, h: 20, label: "Client", required: false }]), templateId);
    try {
      const p = files.completeClientSigning(tokenOf(f), { consent: true, values: { nm: "Zoë Ångström" }, signature: PNG, method: "typed" }, {});
      await expect(p).rejects.toThrow(/Nothing was signed or saved.*\(ř\)|\(ř\).*Nothing was signed or saved/);
      await expect(p).rejects.toMatchObject({ status: 422 });
      expect(files.getFile(ws().id, f.id).status).not.toBe("signed");
      expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE file_id = ?", f.id)!.n).toBe(0);
      // and the signing lock was released: a retry gets the same answer, not "Already signing"
      await expect(files.completeClientSigning(tokenOf(f), { consent: true, values: { nm: "Zoë Ångström" }, signature: PNG, method: "typed" }, {})).rejects.toThrow(/\(ř\)/);
    } finally {
      db.run("UPDATE template_versions SET fields_json = ? WHERE template_id = ?", JSON.stringify(fields), templateId);
    }
  });
});
