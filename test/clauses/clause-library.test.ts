// Clause library: placeholders, validation, rendering, governance, and both stores. Synthetic data only.
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  ClauseError, ClauseLibrary, MemoryClauseStore, SqliteClauseStore, parsePlaceholders, renderBody, validateBody,
  type ClauseAuthorizer, type ClauseStore,
} from "../../lib/clauses";
import { SRC, TestAuth, WS, as } from "./helpers";

// Roles come from the host authorizer (helpers.ts), never from the actor.
const author = as("author-1");
const author2 = as("author-2");
const approver = as("approver-1");
const reader = as("reader-1");
const BODY = "{{party.client.name}} will pay {{fee.amount:money}} within {{notice.days:int}} days of {{start:date}}.";
const PARAMS = { "party.client.name": "Example Client LLC", "fee.amount": "1500", "notice.days": 30, start: "2026-12-01" };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clause-lib-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof ClauseError ? e.code : `other:${e}`; }
  return "no-error";
}

describe("placeholders and validation", () => {
  it("parses typed and untyped placeholders", () => {
    const p = parsePlaceholders(BODY);
    expect(p.issues).toEqual([]);
    expect(p.placeholders).toEqual([
      { path: "party.client.name", type: "text" }, { path: "fee.amount", type: "money" },
      { path: "notice.days", type: "int" }, { path: "start", type: "date" },
    ]);
  });
  it.each([
    ["{{Bad Name}}", "bad_placeholder"], ["{{a:b:c}}", "bad_placeholder"], ["{{a:float}}", "bad_type"],
    ["{{a:int}} {{a:money}}", "type_conflict"], ["oops {{ a", "stray_braces"], ["{{{{a}}}}", "stray_braces"],
    ["{{}}", "bad_placeholder"], ["", "empty_body"],
  ])("rejects %j", (body, expected) => {
    expect(validateBody(body).issues.map((i) => i.code)).toContain(expected);
  });
  it.each([
    "<script>alert(1)</script>", "see <b>this</b>", "click javascript:void(0)", "data:text/html,x", "${x}", "<% x %>",
    "hidden‮text", "bad\u0007char", "&#60;script", "%3Cscript",
  ])("flags unsafe content %j", (body) => {
    expect(validateBody(`Fee {{a}} ${body}`).issues.some((i) => i.code.startsWith("unsafe_"))).toBe(true);
  });
  it.each([
    ["x <{{a}}", "unsafe_adjacent"], ["&#{{n:int}};", "unsafe_escape"], ["${{a}}", "unsafe_adjacent"], ["{{{a}}}", "stray_braces"],
    ["&lt;script&gt;", "unsafe_escape"], ["\uff1cscript\uff1e", "unsafe_html"], ["a\u2028b", "unsafe_control"],
    ["a\u00adb", "unsafe_bidi"], ["a\u{e0041}b", "unsafe_bidi"],
  ])("catches composed or disguised markers %j", (body, expected) => {
    expect(validateBody(body).issues.map((i) => i.code)).toContain(expected);
  });
  it("catches markers assembled at render time", () => {
    expect(code(() => renderBody("x {{a}}", [{ path: "a", type: "text" }], { a: "<script>" }))).toBe("invalid_params");
    // "&#60b" decodes to "<b" in a browser even without the semicolon (S11 L5), so it is refused now.
    expect(code(() => renderBody("{{a}}b", [{ path: "a", type: "text" }], { a: "&#60" }))).toBe("invalid_params");
    expect(code(() => renderBody("&{{a}};", [{ path: "a", type: "text" }], { a: "#60" }))).toBe("invalid_params");
  });
  it("does not flag ordinary drafting", () => {
    for (const ok of ["Client data: means all information supplied.", "If a<b then the lower figure applies.", "Fees (net of tax) & expenses: 50% upfront.", "Pay {{fee.amount:money}}; then {{notice.days:int}}."]) {
      expect(validateBody(ok).issues).toEqual([]);
    }
  });
  it("does not flag plain comparisons or numbered clauses", () => {
    for (const ok of [
      "Clause #{{n:int}} applies.", "See item #{{n:int}}, then #{{m:int}}.", "If a<b and c>d then the lower figure applies.",
      "Where x < y, then z > 3 applies.", "If a<b, the cap is {{fee.amount:money}}; otherwise c>d.",
    ]) {
      expect(validateBody(ok).issues, ok).toEqual([]);
    }
    expect(renderBody("Clause #{{n:int}}: if a<b and c>d", [{ path: "n", type: "int" }], { n: 4 })).toBe("Clause #4: if a<b and c>d");
  });
  it.each([
    "<img src=x onerror=alert(1)>", "<svg/onload=alert(1)>", "<a href=\"x\">y</a>", "<SCRIPT >", "<script", "< script>",
    "<scr<script>ipt>", "<!--x-->", "<?php x ?>", "</div>", "<b\nonclick=1>", "<body onload=x>", "<style>", "<iframe src=x",
    "<br/>", "<br />", "<p>", "<IMG SRC=x>", "<a\thref=x>", "<video><source onerror=x>", "\uff1cimg src=x\uff1e", "<x:y z=1>",
    "<div class=\"a>b\" onclick=x>",
  ])("still flags real markup %j", (body) => {
    expect(validateBody(`Term ${body} end`).issues.map((i) => i.code), body).toContain("unsafe_html");
  });
  it("still flags placeholders assembled into markup", () => {
    for (const [body, want] of [["<{{a}}>", "unsafe_adjacent"], ["<{{a}}", "unsafe_adjacent"], ["&#{{n:int}};", "unsafe_adjacent"], ["&#x{{n:int}};", "unsafe_adjacent"], ["&{{a}};", "unsafe_adjacent"], ["%{{a}}", "unsafe_adjacent"], ["${{a}}", "unsafe_adjacent"]]) {
      expect(validateBody(body).issues.map((i) => i.code), body).toContain(want);
    }
  });
  it("accepts plain clause text", () => {
    expect(validateBody("Either party may end this agreement with {{notice.days:int}} days' written notice.").ok).toBe(true);
  });
});

describe("rendering", () => {
  const ph = parsePlaceholders(BODY).placeholders;
  it("renders deterministically with formatting", () => {
    const a = renderBody(BODY, ph, PARAMS);
    expect(a).toBe("Example Client LLC will pay $1,500.00 within 30 days of 2026-12-01.");
    expect(renderBody(BODY, ph, { ...PARAMS })).toBe(a);
  });
  it("formats money groups and decimals", () => {
    const m = [{ path: "x", type: "money" as const }];
    expect(renderBody("{{x:money}}", m, { x: "1234567.5" })).toBe("$1,234,567.50");
    expect(renderBody("{{x:money}}", m, { x: 0 })).toBe("$0.00");
  });
  it("reports missing, unknown and mistyped parameters", () => {
    const rest: Record<string, string | number> = { ...PARAMS };
    delete rest["fee.amount"];
    expect(code(() => renderBody(BODY, ph, rest))).toBe("invalid_params");
    expect(code(() => renderBody(BODY, ph, { ...PARAMS, extra: "x" }))).toBe("invalid_params");
    for (const bad of [{ "notice.days": "3.5" }, { "fee.amount": "-5" }, { "fee.amount": "1.234" }, { start: "2026-02-30" }, { "party.client.name": "  " }]) {
      expect(code(() => renderBody(BODY, ph, { ...PARAMS, ...bad }))).toBe("invalid_params");
    }
  });
  it("never re-expands or lets unsafe values through", () => {
    expect(code(() => renderBody("{{a}}", [{ path: "a", type: "text" }], { a: "<script>x</script>" }))).toBe("invalid_params");
    // A value that looks like a placeholder is refused outright rather than rendered as literal text.
    expect(code(() => renderBody("{{a}} {{b}}", [{ path: "a", type: "text" }, { path: "b", type: "text" }], { a: "{{b}}", b: "ok" }))).toBe("invalid_params");
  });
  it("does not treat inherited object keys as parameters", () => {
    const ph2 = [{ path: "constructor", type: "text" as const }];
    const issues = (fn: () => unknown) => { try { fn(); return []; } catch (e) { return (e as ClauseError).issues.map((i) => i.code); } };
    expect(issues(() => renderBody("{{constructor}}", ph2, {}))).toEqual(["missing_param"]);
    expect(issues(() => renderBody("{{constructor}}", ph2, Object.create({ constructor: "inherited" })))).toEqual(["missing_param"]);
    expect(issues(() => renderBody("{{constructor}}", ph2, JSON.parse('{"__proto__": "x"}')))).toEqual(["unknown_param", "missing_param"]);
  });
});

function suites(name: string, make: (auth: ClauseAuthorizer) => ClauseStore) {
  describe(`governance (${name})`, () => {
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 10, 9, 12, 0, tick++)).toISOString();
    const lib = (auth = new TestAuth()) => new ClauseLibrary(make(auth), auth, clock);
    const NEW = { id: "payment-terms", kind: "payment" as const, title: "Payment terms", body: BODY, source: { kind: "firm_template" as const, ref: "TPL-2026" } };

    it("creates a draft with provenance and history", () => {
      const l = lib();
      const c = l.createClause(NEW, author);
      expect(c.versions[0]).toMatchObject({ version: 1, state: "draft", provenance: { author: "author-1", source: { kind: "firm_template", ref: "TPL-2026" } } });
      expect(l.get("payment-terms", reader)?.versions[0].history).toHaveLength(1);
      expect(code(() => l.createClause(NEW, author))).toBe("exists");
    });
    it("validates creation input and roles", () => {
      const l = lib();
      expect(code(() => l.createClause({ ...NEW, id: "X" }, author))).toBe("bad_id");
      expect(code(() => l.createClause({ ...NEW, kind: "nope" as never }, author))).toBe("bad_kind");
      expect(code(() => l.createClause({ ...NEW, body: "<b>x</b>" }, author))).toBe("invalid_body");
      expect(code(() => l.createClause({ ...NEW, source: " " as never }, author))).toBe("bad_source");
      expect(code(() => l.createClause(NEW, approver))).toBe("forbidden");
      expect(code(() => l.createClause(NEW, reader))).toBe("forbidden");
      expect(l.list(reader)).toHaveLength(0);
    });
    it("runs draft -> in_review -> approved -> retired", () => {
      const l = lib();
      l.createClause(NEW, author);
      expect(l.submit("payment-terms", 1, author).state).toBe("in_review");
      const a = l.approve("payment-terms", 1, approver);
      expect(a).toMatchObject({ state: "approved", approvedBy: "approver-1" });
      expect(l.retire("payment-terms", 1, approver, "superseded").state).toBe("retired");
      const h = l.get("payment-terms", reader)!.versions[0].history;
      expect(h.map((t) => t.to)).toEqual(["draft", "in_review", "approved", "retired"]);
      expect(h[3].note).toBe("superseded");
    });
    it("enforces roles and author != approver", () => {
      const auth = new TestAuth();
      const l = lib(auth);
      l.createClause(NEW, author);
      expect(code(() => l.submit("payment-terms", 1, approver))).toBe("forbidden");
      l.submit("payment-terms", 1, author);
      expect(code(() => l.approve("payment-terms", 1, author2))).toBe("forbidden");
      auth.set(WS, "author-1", ["editor", "approver"]); // the author now holds both roles
      expect(code(() => l.approve("payment-terms", 1, author))).toBe("self_approval");
      expect(l.get("payment-terms", reader)!.versions[0].state).toBe("in_review");
    });
    it("rejects skipped and backwards moves", () => {
      const l = lib();
      l.createClause(NEW, author);
      expect(code(() => l.approve("payment-terms", 1, approver))).toBe("bad_transition");
      expect(code(() => l.retire("payment-terms", 1, approver))).toBe("bad_transition");
      l.submit("payment-terms", 1, author);
      l.approve("payment-terms", 1, approver);
      expect(code(() => l.sendBack("payment-terms", 1, approver))).toBe("bad_transition");
      l.retire("payment-terms", 1, approver);
      expect(code(() => l.approve("payment-terms", 1, approver))).toBe("bad_transition");
    });
    it("sends back a version and allows editing only drafts, only by the author", () => {
      const auth = new TestAuth();
      const l = lib(auth);
      l.createClause(NEW, author);
      expect(code(() => l.editDraft("payment-terms", 1, "New {{x}}", author2))).toBe("forbidden");
      auth.set(WS, "author-1", ["approver"]); // the host now says the author only approves
      expect(code(() => l.editDraft("payment-terms", 1, "New {{x}}", author))).toBe("forbidden");
      auth.set(WS, "author-1", []); // and now nothing at all
      expect(code(() => l.editDraft("payment-terms", 1, "New {{x}}", author))).toBe("forbidden");
      auth.set(WS, "author-1", ["editor"]);
      expect(l.get("payment-terms", reader)!.versions[0].body).toBe(BODY);
      expect(l.editDraft("payment-terms", 1, "Pay {{x:int}} days", author).placeholders).toEqual([{ path: "x", type: "int" }]);
      l.submit("payment-terms", 1, author);
      expect(code(() => l.editDraft("payment-terms", 1, "x", author))).toBe("immutable");
      l.sendBack("payment-terms", 1, approver, "unclear");
      expect(l.editDraft("payment-terms", 1, "Pay {{x:int}} days, clearer", author).state).toBe("draft");
      expect(code(() => l.editDraft("payment-terms", 1, "<i>x</i>", author))).toBe("invalid_body");
    });
    it("freezes approved versions and uses new versions for changes", () => {
      const l = lib();
      l.createClause(NEW, author);
      l.submit("payment-terms", 1, author);
      l.approve("payment-terms", 1, approver);
      expect(code(() => l.editDraft("payment-terms", 1, "changed", author))).toBe("immutable");
      const v2 = l.addVersion("payment-terms", "Pay {{fee.amount:money}} promptly.", SRC, author2);
      expect(v2).toMatchObject({ version: 2, state: "draft" });
      expect(code(() => l.addVersion("payment-terms", "another", SRC, author))).toBe("open_version");
      expect(l.get("payment-terms", reader)!.versions[0].body).toBe(BODY);
    });
    it("store refuses direct mutation of frozen versions", () => {
      const auth = new TestAuth();
      const store = make(auth);
      const l = new ClauseLibrary(store, auth);
      l.createClause(NEW, author);
      l.submit("payment-terms", 1, author);
      l.approve("payment-terms", 1, approver);
      const v = store.getClause(WS, "payment-terms")!.versions[0];
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...v, body: "tampered" }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...v, state: "draft" }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...v, history: [] }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...v, provenance: { ...v.provenance, author: "x" } }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...v, version: 3 }))).toBe("bad_version");
      l.retire("payment-terms", 1, approver);
      const r = store.getClause(WS, "payment-terms")!.versions[0];
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...r, state: "approved" }))).toBe("immutable");
      expect(store.getClause(WS, "payment-terms")!.versions[0].body).toBe(BODY);
    });
    it("store refuses a skipped review, a pre-approved insert and a forged approval", () => {
      const auth = new TestAuth();
      const store = make(auth);
      const l = new ClauseLibrary(store, auth);
      l.createClause(NEW, author);
      const d = store.getClause(WS, "payment-terms")!.versions[0];
      const approvedTrail = { state: "approved" as const, approvedBy: "x", approvedAt: "t" };
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...d, ...approvedTrail }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...d, state: "retired" }))).toBe("immutable");
      l.submit("payment-terms", 1, author);
      const r = store.getClause(WS, "payment-terms")!.versions[0];
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...r, ...approvedTrail, history: [...r.history, { from: "in_review", to: "approved", by: "other", at: "t" }] }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...r, ...approvedTrail, approvedBy: "author-1", history: [...r.history, { from: "in_review", to: "approved", by: "author-1", at: "t" }] }))).toBe("self_approval");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...r, approvedBy: "x", approvedAt: "t" }))).toBe("immutable");
      expect(store.getClause(WS, "payment-terms")!.versions[0].state).toBe("in_review");
      const pre = { ...d, state: "approved" as const, approvedBy: "x", approvedAt: "t" };
      expect(code(() => store.insertClause(WS, { workspaceId: WS, id: "other-clause", kind: "general", title: "t", createdBy: "a", createdAt: "t", versions: [pre] }))).toBe("immutable");
      expect(code(() => store.saveVersion(WS, "payment-terms", { ...pre, version: 2 }))).toBe("immutable");
      expect(store.getClause(WS, "other-clause")).toBeNull();
    });
    it("only the author submits a draft, and metadata must be plain text", () => {
      const l = lib();
      l.createClause(NEW, author);
      expect(code(() => l.submit("payment-terms", 1, author2))).toBe("forbidden");
      expect(code(() => l.createClause({ ...NEW, id: "other-one", title: "<script>" }, author))).toBe("bad_text");
      // Source is a fixed kind plus an opaque key, so markup cannot get in through it either.
      expect(code(() => l.createClause({ ...NEW, id: "other-one", source: "<b>x</b>" as never }, author))).toBe("bad_source");
      expect(code(() => l.createClause({ ...NEW, id: "other-one", source: { kind: "firm_template", ref: "<b>x</b>" } }, author))).toBe("bad_source");
      expect(code(() => l.createClause({ ...NEW, id: "other-one", title: 5 as never }, author))).toBe("bad_text");
      l.submit("payment-terms", 1, author);
      expect(code(() => l.sendBack("payment-terms", 1, approver, "<b>no</b>"))).toBe("bad_text");
      expect(code(() => l.sendBack("payment-terms", 1, approver, ""))).toBe("bad_text");
      expect(code(() => l.sendBack("payment-terms", 1, approver, "   "))).toBe("bad_text");
      expect(l.get("payment-terms", reader)!.versions[0].state).toBe("in_review");
    });
    it("returns copies, not live references", () => {
      const auth = new TestAuth();
      const store = make(auth);
      new ClauseLibrary(store, auth).createClause(NEW, author);
      const c = store.getClause(WS, "payment-terms")!;
      c.versions[0].body = "mutated";
      expect(store.getClause(WS, "payment-terms")!.versions[0].body).toBe(BODY);
    });
    it("only lets approved versions into a draft", () => {
      const l = lib();
      l.createClause(NEW, author);
      expect(code(() => l.useInDraft("payment-terms", 1, PARAMS, reader))).toBe("not_approved");
      l.submit("payment-terms", 1, author);
      expect(code(() => l.useInDraft("payment-terms", 1, PARAMS, reader))).toBe("not_approved");
      l.approve("payment-terms", 1, approver);
      expect(l.useInDraft("payment-terms", 1, PARAMS, reader)).toContain("$1,500.00");
      expect(code(() => l.useInDraft("payment-terms", 1, { ...PARAMS, "notice.days": "x" }, reader))).toBe("invalid_params");
      l.retire("payment-terms", 1, approver);
      expect(code(() => l.useInDraft("payment-terms", 1, PARAMS, reader))).toBe("not_approved");
      expect(code(() => l.useInDraft("payment-terms", 9, PARAMS, reader))).toBe("not_found");
      expect(code(() => l.useInDraft("missing", 1, PARAMS, reader))).toBe("not_found");
      expect(l.latestApproved("payment-terms", reader)).toBeNull();
    });
    it("only the latest approved version can be used; earlier ones are superseded, not changed", () => {
      const l = lib();
      l.createClause(NEW, author);
      l.submit("payment-terms", 1, author);
      l.approve("payment-terms", 1, approver);
      expect(l.useInDraft("payment-terms", 1, PARAMS, reader)).toContain("$1,500.00");
      l.addVersion("payment-terms", "Pay {{fee.amount:money}} promptly.", SRC, author);
      l.submit("payment-terms", 2, author);
      expect(l.useInDraft("payment-terms", 1, PARAMS, reader)).toContain("$1,500.00"); // v2 not yet approved
      l.approve("payment-terms", 2, approver);
      expect(code(() => l.useInDraft("payment-terms", 1, PARAMS, reader))).toBe("superseded");
      expect(l.useInDraft("payment-terms", 2, { "fee.amount": "10" }, reader)).toBe("Pay $10.00 promptly.");
      expect(l.get("payment-terms", reader)!.versions[0].state).toBe("approved");
      l.retire("payment-terms", 2, approver);
      expect(code(() => l.useInDraft("payment-terms", 2, { "fee.amount": "10" }, reader))).toBe("not_approved");
      // Retiring the newest version never brings older approved text back (see the S14 hardening defence tests).
      expect(code(() => l.useInDraft("payment-terms", 1, PARAMS, reader))).toBe("superseded");
      expect(l.latestApproved("payment-terms", reader)).toBeNull();
    });
    it("keeps history after retiring and finds the latest approved version", () => {
      const l = lib();
      l.createClause(NEW, author);
      l.submit("payment-terms", 1, author);
      l.approve("payment-terms", 1, approver);
      l.addVersion("payment-terms", "Pay {{fee.amount:money}}.", SRC, author);
      l.submit("payment-terms", 2, author);
      l.approve("payment-terms", 2, approver);
      l.retire("payment-terms", 1, approver);
      expect(l.latestApproved("payment-terms", reader)?.version).toBe(2);
      expect(l.get("payment-terms", reader)!.versions).toHaveLength(2);
      expect(l.get("payment-terms", reader)!.versions[0].state).toBe("retired");
    });
  });
}

suites("memory", (auth) => new MemoryClauseStore(auth));
suites("sqlite", (auth) => new SqliteClauseStore(path.join(fs.mkdtempSync(path.join(tmp, "db-")), "clauses.db"), { authorizer: auth }));

describe("sqlite store", () => {
  const auth = new TestAuth();
  it("persists across reopen", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "persist-")), "c.db");
    const s1 = new SqliteClauseStore(file, { authorizer: auth });
    const l1 = new ClauseLibrary(s1, auth, () => "2026-11-09T12:00:00.000Z");
    l1.createClause({ id: "term-notice", kind: "term", title: "Notice", body: "{{notice.days:int}} days", source: SRC }, author);
    l1.submit("term-notice", 1, author);
    l1.approve("term-notice", 1, approver);
    s1.close();
    const l2 = new ClauseLibrary(new SqliteClauseStore(file, { authorizer: auth }), auth);
    expect(l2.get("term-notice", reader)?.versions[0]).toMatchObject({ state: "approved", approvedBy: "approver-1" });
    expect(l2.useInDraft("term-notice", 1, { "notice.days": 14 }, reader)).toBe("14 days");
  });
  it("database triggers block tampering that bypasses the store", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "trig-")), "c.db");
    const s = new SqliteClauseStore(file, { authorizer: auth });
    const l = new ClauseLibrary(s, auth, () => "2026-11-09T12:00:00.000Z");
    l.createClause({ id: "term-notice", kind: "term", title: "Notice", body: "{{n:int}} days", source: SRC }, author);
    l.createClause({ id: "other-one", kind: "term", title: "Other", body: "{{n:int}} days", source: SRC }, author);
    l.submit("term-notice", 1, author);
    const raw = new DatabaseSync(file);
    // draft/in_review: no skipped review, no forged approval
    expect(() => raw.exec("UPDATE clause_library_versions SET state='approved', approved_by='x', history='[]' WHERE clause_id='other-one'")).toThrow(/immutable/);
    expect(() => raw.exec("UPDATE clause_library_versions SET state='retired' WHERE clause_id='other-one'")).toThrow(/immutable/);
    expect(() => raw.exec("UPDATE clause_library_versions SET approved_by='x' WHERE clause_id='term-notice'")).toThrow(/immutable/);
    expect(() => raw.exec("UPDATE clause_library_versions SET state='approved', approved_by='author-1', history=history||' ' WHERE clause_id='term-notice'")).toThrow(/immutable/);
    expect(() => raw.exec("UPDATE clause_library_versions SET body='x' WHERE clause_id='term-notice'")).toThrow(/immutable/);
    l.approve("term-notice", 1, approver);
    // approved: nothing but retiring
    for (const set of ["body='x'", "state='draft'", "history='[]'", "approved_at='z'", "approved_by='z'", "version=7", "clause_id='other-one'", "source='z'", "author='z'"]) {
      expect(() => raw.exec(`UPDATE clause_library_versions SET ${set} WHERE clause_id='term-notice'`), set).toThrow(/immutable/);
    }
    expect(() => raw.exec("DELETE FROM clause_library_versions")).toThrow(/never deleted/);
    expect(() => raw.exec("DELETE FROM clause_library_clauses")).toThrow(/never deleted/);
    expect(() => raw.exec("UPDATE clause_library_clauses SET title='z'")).toThrow(/immutable/);
    expect(() => raw.exec("INSERT INTO clause_library_versions VALUES ('ws-a','other-one',2,'b','[]','a','{\"kind\":\"firm_template\"}','t','approved','x','t','[]')")).toThrow(/draft/);
    l.retire("term-notice", 1, approver);
    expect(() => raw.exec("UPDATE clause_library_versions SET state='approved' WHERE clause_id='term-notice'")).toThrow(/immutable/);
    raw.close();
  });
  it("rejects a duplicate id and rolls back when a write fails midway", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "rb-")), "c.db");
    const s = new SqliteClauseStore(file, { authorizer: auth });
    const l = new ClauseLibrary(s, auth);
    const NEW = { id: "dup-one", kind: "general" as const, title: "t", body: "plain", source: SRC };
    l.createClause(NEW, author);
    expect(code(() => l.createClause(NEW, author))).toBe("exists");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON clause_library_versions BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => l.createClause({ ...NEW, id: "dup-two" }, author)).toThrow(/boom/);
    expect(s.getClause(WS, "dup-two")).toBeNull(); // the clause row was rolled back with the failed version insert
    raw.exec("DROP TRIGGER fail_insert");
    l.createClause({ ...NEW, id: "dup-two" }, author);
    expect(s.getClause(WS, "dup-two")).not.toBeNull();
    raw.close();
  });
  it("enforces foreign keys on its own connection", () => {
    const s = new SqliteClauseStore(":memory:", { authorizer: auth });
    const db = (s as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec("INSERT INTO clause_library_versions VALUES ('ws-a','no-such-clause',1,'b','[]','a','{\"kind\":\"firm_template\"}','t','draft',NULL,NULL,'[]')")).toThrow(/FOREIGN KEY/);
    const stray = { version: 1, body: "x", placeholders: [], provenance: { author: "a", source: SRC, createdAt: "t" }, state: "draft" as const, approvedBy: null, approvedAt: null, history: [{ from: null, to: "draft" as const, by: "a", at: "t" }] };
    expect(code(() => s.saveVersion(WS, "no-such-clause", stray))).toBe("not_found");
    expect(s.listClauses(WS)).toEqual([]);
  });
  it("a second writer waits for the lock instead of failing", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "busy-")), "c.db");
    const s = new SqliteClauseStore(file, { authorizer: auth });
    const shared = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const { DatabaseSync } = require("node:sqlite");
       const flag = new Int32Array(workerData.buf);
       const db = new DatabaseSync(workerData.file);
       db.exec("BEGIN IMMEDIATE");
       Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
       db.exec("COMMIT"); db.close();
       Atomics.store(flag, 0, 2); Atomics.notify(flag, 0);`,
      { eval: true, workerData: { buf: shared.buffer, file } },
    );
    try {
      expect(Atomics.wait(shared, 0, 0, 10_000)).not.toBe("timed-out"); // worker now holds the write lock
      new ClauseLibrary(s, auth).createClause({ id: "wait-one", kind: "general", title: "t", body: "plain", source: SRC }, author);
      // The write only went through after the worker committed (flag 2), i.e. it waited rather than failed.
      expect(Atomics.load(shared, 0)).toBe(2);
      expect(s.getClause(WS, "wait-one")).not.toBeNull();
    } finally {
      void worker.terminate();
    }
  });
  it("fails fast with a zero busy timeout while another writer holds the lock", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "nobusy-")), "c.db");
    const s = new SqliteClauseStore(file, { authorizer: auth, busyTimeoutMs: 0 });
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE");
    expect(() => new ClauseLibrary(s, auth).createClause({ id: "wait-one", kind: "general", title: "t", body: "plain", source: SRC }, author)).toThrow(/locked/);
    holder.exec("ROLLBACK");
    holder.close();
    expect(s.getClause(WS, "wait-one")).toBeNull();
    expect(code(() => new SqliteClauseStore(":memory:", { authorizer: auth, busyTimeoutMs: -1 }))).toBe("bad_option");
  });
  it("detects a concurrent change through a second connection", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "cc-")), "c.db");
    const s1 = new SqliteClauseStore(file, { authorizer: auth });
    const s2 = new SqliteClauseStore(file, { authorizer: auth });
    const l1 = new ClauseLibrary(s1, auth);
    l1.createClause({ id: "dup-one", kind: "general", title: "t", body: "plain", source: SRC }, author);
    const stale = s2.getClause(WS, "dup-one")!.versions[0];
    l1.submit("dup-one", 1, author);
    // s2 still holds the draft; its edit must not overwrite the in_review version
    expect(code(() => s2.saveVersion(WS, "dup-one", { ...stale, body: "changed" }))).toBe("immutable");
    expect(s1.getClause(WS, "dup-one")!.versions[0].body).toBe("plain");
  });
});

describe("module hygiene", () => {
  it("does not touch lib/db.ts or make claims about legal effect", () => {
    const dir = path.join(__dirname, "../../lib/clauses");
    const claim = new RegExp(["legally", "compliant|", "guarantee[sd]? (?:legal|compliance)|", "ensures? compliance"].join(""), "i");
    // The module core (top-level files) never touches the app; lib/clauses/app/ is the host binding and the only place
    // that uses the app database or session.
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src).not.toMatch(claim);
      expect(src).not.toMatch(/from "(?:\.\.\/)+lib\//);
      expect(src).not.toMatch(/from "(?:\.\.\/)+(?:db|auth)"|@\/lib\//);
    }
    const host = path.join(dir, "app");
    for (const f of fs.existsSync(host) ? fs.readdirSync(host) : []) expect(fs.readFileSync(path.join(dir, "app", f), "utf8")).not.toMatch(claim);
  });
});
