// S11 red-team findings L2 (retire policy), L4, L5 and L6 against the clause library. Each block ports a
// `FINDING:` test from test/redteam/clauselib.redteam.test.ts (which asserted the weakness) and now requires
// the library to fail closed. Synthetic data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  ClauseError, ClauseLibrary, MemoryClauseStore, SqliteClauseStore, clauseRolesForMember, formatValue, renderBody,
  unsafeMarkers, validateBody, type ClauseAuthorizer, type ClauseStore, type ClauseVersion,
} from "../../lib/clauses";
import { SRC, TestAuth, WS, WS_B, as } from "./helpers";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clause-hard-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const author = as("author-1");
const author2 = as("author-2");
const approver = as("approver-1");
const reader = as("reader-1");
const owner = as("owner-1");

function fail(fn: () => unknown): { code: string; issues: string[] } {
  try { fn(); } catch (e) {
    if (e instanceof ClauseError) return { code: e.code, issues: e.issues.map((i) => i.code) };
    return { code: `other:${(e as Error).message}`, issues: [] };
  }
  return { code: "no-error", issues: [] };
}
const code = (fn: () => unknown) => fail(fn).code;
const issueCodes = (body: string) => validateBody(body).issues.map((i) => i.code);

type Make = (auth: ClauseAuthorizer) => ClauseStore;
const STORES: Array<[string, Make]> = [
  ["memory", (auth) => new MemoryClauseStore(auth)],
  ["sqlite", (auth) => new SqliteClauseStore(path.join(fs.mkdtempSync(path.join(tmp, "db-")), "c.db"), { authorizer: auth })],
];

function setup(make: Make = STORES[0][1], auth = new TestAuth()) {
  const store = make(auth);
  const lib = new ClauseLibrary(store, auth, () => "2026-01-01T00:00:00.000Z");
  return { auth, store, lib };
}
function approvedClause(body: string, id = "cl1") {
  const s = setup();
  s.lib.createClause({ id, kind: "fees", title: "Fees", body, source: SRC }, author);
  s.lib.submit(id, 1, author);
  s.lib.approve(id, 1, approver);
  return { ...s, use: (params: Record<string, string | number>) => s.lib.useInDraft(id, 1, params, reader) };
}
/** A version in review, written straight to the store, approved by `by`. */
function approvalBy(v: ClauseVersion, by: string): ClauseVersion {
  return { ...v, state: "approved", approvedBy: by, approvedAt: "t2", history: [...v.history, { from: "in_review", to: "approved", by, at: "t2" }] };
}

describe("L4: parameter values that read as something else", () => {
  it("int refuses zero and negatives, so 'within -30 days' cannot render", () => {
    for (const v of [-30, "-30", 0, "0", -0, "-999999999999999", "00"]) {
      expect(formatValue("int", v).ok, JSON.stringify(v)).toBe(false);
    }
    expect(formatValue("int", 30)).toEqual({ ok: true, text: "30" });
    expect(formatValue("int", "007")).toEqual({ ok: true, text: "7" });
    const c = approvedClause("{{party}} pays {{amount:money}} within {{days:int}} days.");
    expect(fail(() => c.use({ party: "Acme", amount: "100", days: -30 }))).toEqual({ code: "invalid_params", issues: ["bad_param"] });
    expect(code(() => c.use({ party: "Acme", amount: "0", days: "-999999999999999" }))).toBe("invalid_params");
    expect(c.use({ party: "Acme", amount: "0", days: 14 })).toBe("Acme pays $0.00 within 14 days.");
  });
  it("a text placeholder refuses NaN, Infinity and exponent-form numbers", () => {
    for (const v of [NaN, Infinity, 1e21]) expect(formatValue("text", v).ok, String(v)).toBe(false);
    const c = approvedClause("Client: {{name}}.");
    for (const v of [NaN, Infinity, -Infinity, 1e21, 1e-7]) {
      expect(code(() => c.use({ name: v })), String(v)).toBe("invalid_params");
    }
    expect(c.use({ name: 42 })).toBe("Client: 42.");
    expect(c.use({ name: -2.5 })).toBe("Client: -2.5.");
  });
  it("look-alike (Cyrillic, Greek, Cherokee) letters cannot imitate a Latin party name", () => {
    expect(formatValue("text", "Maple Row Studio Ltd".replace("e", "\u0435")).ok).toBe(false);
    const c = approvedClause("Client: {{name}}.");
    for (const name of [
      "Maple Row Studio Ltd".replace("e", "\u0435"), // Cyrillic ie
      "Maple R\u03bfw Studio Ltd", // Greek omicron
      "\u0410\u0412\u0421 Holdings", // Cyrillic ABC next to Latin
      "\u0410\u0412\u0421", // Cyrillic only, every letter imitating Latin
      "\u13aa\u13f4\u13df", // Cherokee imitating ABC
    ]) {
      expect(fail(() => c.use({ name })), name).toEqual({ code: "invalid_params", issues: ["bad_param"] });
    }
    for (const name of ["Soci\u00e9t\u00e9 G\u00e9n\u00e9rale", "M\u00fcller GmbH", "\u041e\u041e\u041e \u0420\u043e\u043c\u0430\u0448\u043a\u0430", "\u0394\u03b5\u03bb\u03c4\u03b1"]) {
      expect(c.use({ name })).toBe(`Client: ${name}.`);
    }
  });
  it("a body or title may not hide a look-alike letter inside a Latin word", () => {
    expect(issueCodes("Client shall p\u0430y the fee.")).toContain("unsafe_mixed_script");
    expect(issueCodes("The \u03b1 factor and \u041e\u041e\u041e entities apply.")).toEqual([]);
    const { lib } = setup();
    expect(code(() => lib.createClause({ id: "cl2", kind: "fees", title: "F\u0435es", body: "x", source: SRC }, author))).toBe("bad_text");
  });
  it("a value may not carry a link", () => {
    expect(formatValue("text", "https://evil.example.test/pay").ok).toBe(false);
    const c = approvedClause("Client: {{name}}.");
    for (const name of ["https://evil.example.test/pay", "Pay at www.evil.example.test", "mailto:x@example.test", "HTTPS : //x.example.test"]) {
      expect(code(() => c.use({ name })), name).toBe("invalid_params");
    }
    expect(c.use({ name: "notices@example.test" })).toBe("Client: notices@example.test.");
  });
});

describe("L5: the unsafe-content scanner is an allow-list by Unicode property", () => {
  const invisible = [
    "\u2060", "\u061c", "\u3164", "\u180e", "\u034f", "\ufe0f", "\u2062", "\u115f", "\u1160", "\uffa0", "\u{e0100}",
    "\u2800", "\ue000", "\u{f0000}", "\u0378", "\ud800", "\u00ad", "\u200b", "\u202e", "\u2066", "\ufeff", "\u{e0041}",
  ];
  it.each(invisible.map((c) => [`U+${c.codePointAt(0)!.toString(16).toUpperCase()}`, c]))("refuses %s in a body, a value and a title", (_n, ch) => {
    expect(issueCodes(`Client shall not${ch} be liable.`)).toContain("unsafe_bidi");
    const c = approvedClause("Client: {{name}}.");
    expect(code(() => c.use({ name: `Acme${ch}Ltd` }))).toBe("invalid_params");
    expect(code(() => c.lib.createClause({ id: "cl2", kind: "fees", title: `T${ch}x`, body: "x", source: SRC }, author))).toBe("bad_text");
  });
  it("refuses exotic spaces and C1 controls, keeps plain, no-break and narrow no-break spaces", () => {
    for (const ch of ["\u2000", "\u2003", "\u205f", "\u3000", "\u1680"]) expect(issueCodes(`a${ch}b`), ch.codePointAt(0)!.toString(16)).toContain("unsafe_char");
    for (const ch of ["\u0080", "\u009b", "\u0085"]) expect(issueCodes(`a${ch}b`)).toContain("unsafe_control");
    expect(issueCodes("Section\u00a05 and 10\u202f% apply.\tTabbed.\nNext line.")).toEqual([]);
  });
  it("refuses a stack of combining marks", () => {
    expect(issueCodes("Z\u0301\u0302\u0303\u0304\u0305algo")).toContain("unsafe_marks");
    expect(issueCodes("Cafe\u0301 and Vie\u0323\u0302t")).toEqual([]);
  });
  it("refuses markdown links, images, link definitions and autolinks in a body and in values", () => {
    for (const b of [
      "See [terms](https://evil.example.test/login).", "![x](https://evil.example.test/p.png)", "[terms]: https://evil.example.test",
      "Visit <https://evil.example.test>.", "Mail <mailto:x@example.test>.",
    ]) {
      expect(issueCodes(b), b).toContain("unsafe_markdown");
    }
    const c = approvedClause("x {{a}} y");
    expect(code(() => c.use({ a: "[pay here](https://evil.example.test/pay)" }))).toBe("invalid_params");
    expect(code(() => c.use({ a: "[pay here](/pay)" }))).toBe("invalid_params");
    expect(issueCodes("[Client Name] (the \"Client\") and [Provider] [Address] agree.")).toEqual([]);
  });
  it("refuses an HTML entity without its semicolon, which browsers still decode", () => {
    for (const b of ["a &ltscript&gtalert(1)&lt/script&gt b", "a &#60script b", "&#x3cb", "&quotx", "&AMP", "&nbsp;", "&copy;"]) {
      expect(issueCodes(b), b).toContain("unsafe_escape");
    }
    for (const ok of ["AT&T and R&D", "Fees & expenses", "Smith & Co. Ltd", "Q&A session"]) expect(issueCodes(ok), ok).toEqual([]);
  });
  it("refuses double-encoded markup and backslash escapes", () => {
    for (const b of ["a %253Cscript%253E b", "\\u003cscript\\u003e", "\\u{3c}b", "\\x3cb", "&amp;lt;b&amp;gt;", "%25%37%42"]) {
      expect(issueCodes(b), b).toContain("unsafe_escape");
    }
    const c = approvedClause("x {{a}} y");
    expect(code(() => c.use({ a: "%253Cb%253E" }))).toBe("invalid_params");
    for (const ok of ["50% upfront", "Acme 100% owned", "a 10 % discount"]) expect(issueCodes(ok), ok).toEqual([]);
  });
  it("still accepts ordinary drafting", () => {
    expect(unsafeMarkers("Either party may end this agreement with 30 days' written notice (\u00a7 4.2, \u00bd of fees, 5 \u00b5m, \u00a9 2026, \u201cquoted\u201d \u2014 ok).")).toEqual([]);
  });
});

describe.each(STORES)("L2 policy: retiring the newest version never revives older text (%s)", (_n, make) => {
  function twoApproved() {
    const s = setup(make);
    s.lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Old terms", source: SRC }, author);
    s.lib.submit("cl1", 1, author);
    s.lib.approve("cl1", 1, approver);
    s.lib.addVersion("cl1", "Newer terms", SRC, author);
    s.lib.submit("cl1", 2, author);
    s.lib.approve("cl1", 2, approver);
    return s;
  }
  it("after retiring v2, v1 stays superseded and nothing is usable", () => {
    const { lib } = twoApproved();
    lib.retire("cl1", 2, approver, "withdrawn: wrong liability cap");
    expect(code(() => lib.useInDraft("cl1", 1, {}, reader))).toBe("superseded");
    expect(code(() => lib.useInDraft("cl1", 2, {}, reader))).toBe("not_approved");
    expect(lib.latestApproved("cl1", reader)).toBeNull();
    expect(lib.get("cl1", reader)!.versions.map((v) => v.state)).toEqual(["approved", "retired"]);
  });
  it("old wording comes back only as a new, separately approved version", () => {
    const { lib } = twoApproved();
    lib.retire("cl1", 2, approver);
    lib.addVersion("cl1", "Old terms", SRC, author);
    expect(code(() => lib.useInDraft("cl1", 1, {}, reader))).toBe("superseded");
    lib.submit("cl1", 3, author);
    lib.approve("cl1", 3, approver);
    expect(lib.useInDraft("cl1", 3, {}, reader)).toBe("Old terms");
    expect(lib.latestApproved("cl1", reader)!.version).toBe(3);
  });
  it("retiring an older version leaves the newest usable", () => {
    const { lib } = twoApproved();
    lib.retire("cl1", 1, approver);
    expect(lib.useInDraft("cl1", 2, {}, reader)).toBe("Newer terms");
  });
});

describe("L6: roles come from the host, never from the caller", () => {
  it("refuses to run without a host authorizer (fail closed)", () => {
    const auth = new TestAuth();
    for (const bad of [undefined, null, {}, { rolesOf: "approver" }, { rolesOf: () => ["approver"], personOf: 1 }]) {
      expect(code(() => new MemoryClauseStore(bad as never)), JSON.stringify(bad)).toBe("no_authorizer");
      expect(code(() => new ClauseLibrary(new MemoryClauseStore(auth), bad as never)), JSON.stringify(bad)).toBe("no_authorizer");
      expect(code(() => new SqliteClauseStore(":memory:", { authorizer: bad as never }))).toBe("no_authorizer");
    }
    expect(code(() => new SqliteClauseStore(":memory:", undefined as never))).toBe("no_authorizer");
  });
  it("an actor that carries roles is refused, so the S11 second-identity payload no longer works", () => {
    const auth = new TestAuth({ [WS]: { alice: ["editor"] } });
    const { lib } = setup(undefined, auth);
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "My own terms", source: SRC }, as("alice"));
    lib.submit("cl1", 1, as("alice"));
    expect(code(() => lib.approve("cl1", 1, { id: "alice-2", roles: ["approver"] } as never))).toBe("bad_actor");
    expect(code(() => lib.approve("cl1", 1, { workspaceId: WS, id: "alice-2", roles: ["approver"] } as never))).toBe("bad_actor");
    // Without a claimed role, alice-2 is whatever the host says: here not a member at all.
    expect(code(() => lib.approve("cl1", 1, as("alice-2")))).toBe("forbidden");
    expect(lib.get("cl1", as("alice"))!.versions[0].state).toBe("in_review");
  });
  it("a second account the host maps to the same person cannot approve the author's text", () => {
    const auth = new TestAuth({ [WS]: { alice: ["editor"], "alice-2": ["approver"] } }).samePersonAs(WS, "alice-2", "alice");
    const { lib, store } = setup(undefined, auth);
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "My own terms", source: SRC }, as("alice"));
    lib.submit("cl1", 1, as("alice"));
    expect(code(() => lib.approve("cl1", 1, as("alice-2")))).toBe("self_approval");
    const v = store.getClause(WS, "cl1")!.versions[0];
    expect(code(() => store.saveVersion(WS, "cl1", approvalBy(v, "alice-2")))).toBe("self_approval");
    // A person the host cannot identify is treated as possibly the author.
    const unknown = new TestAuth({ [WS]: { alice: ["editor"], ghost: ["approver"] } });
    unknown.personOf = (_ws, u) => (u === "ghost" ? null : u);
    const s2 = setup(undefined, unknown);
    s2.lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "x", source: SRC }, as("alice"));
    s2.lib.submit("cl1", 1, as("alice"));
    expect(code(() => s2.lib.approve("cl1", 1, as("ghost")))).toBe("self_approval");
  });
  it("odd authorizer answers grant nothing", () => {
    for (const roles of ["approver", { 0: "approver" }, ["__proto__", "constructor", "toString"], ["APPROVER"], [null]]) {
      const auth = new TestAuth();
      auth.rolesOf = (ws, u) => (u === "odd" ? (roles as never) : TestAuth.prototype.rolesOf.call(auth, ws, u));
      const { lib } = setup(undefined, auth);
      lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "x", source: SRC }, author);
      lib.submit("cl1", 1, author);
      expect(code(() => lib.approve("cl1", 1, as("odd"))), JSON.stringify(roles)).toBe("forbidden");
      expect(code(() => lib.get("cl1", as("odd")))).toBe("forbidden");
    }
    const throwing = new TestAuth();
    throwing.rolesOf = () => { throw new Error("membership lookup failed"); };
    expect(() => new ClauseLibrary(new MemoryClauseStore(throwing), throwing).list(reader)).toThrow(/membership lookup failed/);
  });
  it("the production mapping never lets editing imply approval", () => {
    expect(clauseRolesForMember("owner")).toContain("approver");
    expect(clauseRolesForMember("admin")).toContain("approver");
    expect(clauseRolesForMember("staff")).toEqual(["viewer", "editor"]);
    for (const r of ["viewer", "guest", "", null, undefined, "__proto__"]) expect(clauseRolesForMember(r as never)).toEqual([]);
  });
});

describe.each(STORES)("L6: permission denials (%s)", (_n, make) => {
  function inReview(auth = new TestAuth()) {
    const s = setup(make, auth);
    s.lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Text", source: SRC }, author);
    s.lib.submit("cl1", 1, author);
    return s;
  }
  it("an editor can never approve, send back or retire, through the library or the store", () => {
    const { lib, store } = inReview();
    expect(code(() => lib.approve("cl1", 1, author2))).toBe("forbidden");
    expect(code(() => lib.sendBack("cl1", 1, author2))).toBe("forbidden");
    const v = store.getClause(WS, "cl1")!.versions[0];
    expect(code(() => store.saveVersion(WS, "cl1", approvalBy(v, "author-2")))).toBe("forbidden");
    lib.approve("cl1", 1, approver);
    expect(code(() => lib.retire("cl1", 1, author2))).toBe("forbidden");
    const a = store.getClause(WS, "cl1")!.versions[0];
    expect(code(() => store.saveVersion(WS, "cl1", { ...a, state: "retired", history: [...a.history, { from: "approved", to: "retired", by: "author-2", at: "t3" }] }))).toBe("forbidden");
  });
  it("the store checks the approver's role itself: a direct write naming a non-approver is refused", () => {
    const { lib, store } = inReview();
    const v = store.getClause(WS, "cl1")!.versions[0];
    for (const by of ["random-reader", "reader-1", "author-2"]) {
      expect(code(() => store.saveVersion(WS, "cl1", approvalBy(v, by))), by).toBe("forbidden");
    }
    expect(code(() => lib.useInDraft("cl1", 1, {}, reader))).toBe("not_approved");
    store.saveVersion(WS, "cl1", approvalBy(v, "approver-1"));
    expect(lib.useInDraft("cl1", 1, {}, reader)).toBe("Text");
  });
  it("the store refuses a submit by someone other than the author and a new version by a non-editor", () => {
    const s = setup(make);
    s.lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Text", source: SRC }, author);
    const d = s.store.getClause(WS, "cl1")!.versions[0];
    const submit = (by: string) => ({ ...d, state: "in_review" as const, history: [...d.history, { from: "draft" as const, to: "in_review" as const, by, at: "t" }] });
    expect(code(() => s.store.saveVersion(WS, "cl1", submit("author-2")))).toBe("forbidden");
    expect(code(() => s.store.saveVersion(WS, "cl1", submit("approver-1")))).toBe("forbidden");
    const draft = (by: string, version = 1) => ({ ...d, version, provenance: { ...d.provenance, author: by }, history: [{ from: null, to: "draft" as const, by, at: "t" }] });
    expect(code(() => s.store.insertClause(WS, { workspaceId: WS, id: "cl2", kind: "fees", title: "T", createdBy: "reader-1", createdAt: "t", versions: [draft("reader-1")] }))).toBe("forbidden");
    expect(code(() => s.store.insertClause(WS, { workspaceId: WS, id: "cl3", kind: "fees", title: "T", createdBy: "approver-1", createdAt: "t", versions: [draft("approver-1")] }))).toBe("forbidden");
    expect(s.store.getClause(WS, "cl2")).toBeNull();
    // A draft edit is refused once its author has lost edit permission.
    s.auth.set(WS, "author-1", ["viewer"]);
    expect(code(() => s.store.saveVersion(WS, "cl1", { ...d, body: "Changed" }))).toBe("forbidden");
    expect(code(() => s.lib.editDraft("cl1", 1, "Changed", author))).toBe("forbidden");
  });
  it("a revoked approver can no longer approve", () => {
    const { lib, auth, store } = inReview();
    auth.set(WS, "approver-1", null);
    expect(code(() => lib.approve("cl1", 1, approver))).toBe("forbidden");
    const v = store.getClause(WS, "cl1")!.versions[0];
    expect(code(() => store.saveVersion(WS, "cl1", approvalBy(v, "approver-1")))).toBe("forbidden");
  });
  it("an owner holding every role still cannot approve their own version", () => {
    const s = setup(make);
    s.lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Text", source: SRC }, owner);
    s.lib.submit("cl1", 1, owner);
    expect(code(() => s.lib.approve("cl1", 1, owner))).toBe("self_approval");
    s.lib.approve("cl1", 1, approver);
    expect(s.lib.useInDraft("cl1", 1, {}, reader)).toBe("Text");
  });
  it("a viewer reads and uses approved text but cannot write anything", () => {
    const { lib } = inReview();
    expect(lib.get("cl1", reader)).not.toBeNull();
    expect(lib.list(reader)).toHaveLength(1);
    expect(code(() => lib.createClause({ id: "cl9", kind: "fees", title: "T", body: "x", source: SRC }, reader))).toBe("forbidden");
    expect(code(() => lib.approve("cl1", 1, reader))).toBe("forbidden");
    expect(code(() => lib.sendBack("cl1", 1, reader))).toBe("forbidden");
  });
});

describe.each(STORES)("L6: cross-tenant isolation (%s)", (_n, make) => {
  function twoTenants() {
    const auth = new TestAuth({
      [WS]: { "author-a": ["editor"], "approver-a": ["approver"], "reader-a": ["viewer"] },
      [WS_B]: { "author-b": ["editor"], "approver-b": ["approver"], "reader-b": ["viewer"] },
    });
    const s = setup(make, auth);
    s.lib.createClause({ id: "b-only", kind: "fees", title: "B", body: "B text", source: SRC }, as("author-b", WS_B));
    s.lib.submit("b-only", 1, as("author-b", WS_B));
    s.lib.createClause({ id: "shared-id", kind: "fees", title: "B", body: "B wording", source: SRC }, as("author-b", WS_B));
    s.lib.createClause({ id: "shared-id", kind: "fees", title: "A", body: "A wording", source: SRC }, as("author-a"));
    return s;
  }
  it("an approver of workspace A cannot approve, read, list, use or retire workspace B's clauses", () => {
    const { lib } = twoTenants();
    const claimB = as("approver-a", WS_B); // claims workspace B, but the host says they are not a member there
    expect(code(() => lib.approve("b-only", 1, claimB))).toBe("forbidden");
    expect(code(() => lib.get("b-only", claimB))).toBe("forbidden");
    expect(code(() => lib.list(claimB))).toBe("forbidden");
    expect(code(() => lib.useInDraft("b-only", 1, {}, claimB))).toBe("forbidden");
    const inA = as("approver-a");
    expect(code(() => lib.approve("b-only", 1, inA))).toBe("not_found");
    expect(lib.get("b-only", inA)).toBeNull();
    expect(lib.list(inA).map((c) => c.id)).toEqual(["shared-id"]);
    lib.approve("b-only", 1, as("approver-b", WS_B));
    expect(code(() => lib.retire("b-only", 1, inA))).toBe("not_found");
    expect(code(() => lib.retire("b-only", 1, claimB))).toBe("forbidden");
    expect(code(() => lib.useInDraft("b-only", 1, {}, as("reader-a")))).toBe("not_found");
    expect(lib.useInDraft("b-only", 1, {}, as("reader-b", WS_B))).toBe("B text");
  });
  it("the same clause id in two workspaces is two independent clauses", () => {
    const { lib } = twoTenants();
    expect(lib.get("shared-id", as("reader-a"))!.versions[0].body).toBe("A wording");
    expect(lib.get("shared-id", as("reader-b", WS_B))!.versions[0].body).toBe("B wording");
    expect(code(() => lib.submit("shared-id", 1, as("author-b")))).toBe("forbidden"); // author-b is not a member of A
    lib.submit("shared-id", 1, as("author-a"));
    expect(lib.get("shared-id", as("reader-b", WS_B))!.versions[0].state).toBe("draft");
  });
  it("the store scopes every read and write by workspace", () => {
    const { store } = twoTenants();
    expect(store.getClause(WS, "b-only")).toBeNull();
    expect(store.listClauses(WS).map((c) => c.id)).toEqual(["shared-id"]);
    const v = store.getClause(WS_B, "b-only")!.versions[0];
    expect(code(() => store.saveVersion(WS, "b-only", approvalBy(v, "approver-a")))).toBe("not_found");
    expect(code(() => store.saveVersion(WS_B, "b-only", approvalBy(v, "approver-a")))).toBe("forbidden");
    const c = store.getClause(WS_B, "b-only")!;
    expect(code(() => store.insertClause(WS, c))).toBe("bad_workspace");
    expect(code(() => store.getClause("", "b-only"))).toBe("bad_workspace");
    expect(store.getClause(WS_B, "b-only")!.versions[0].state).toBe("in_review");
  });
});

describe("L6: provenance source is structured, never free text", () => {
  it("refuses a free-text source that claims approval or authority", () => {
    const { lib } = setup();
    expect(code(() => lib.createClause({ id: "cl1", kind: "liability", title: "Liability", body: "Text", source: "Approved by General Counsel, ticket LEG-1234" as never }, author))).toBe("bad_source");
    for (const source of [
      { kind: "approved_by_gc" }, { kind: "firm_template", ref: "Approved by General Counsel" }, { kind: "firm_template", ref: "LEG 1234" },
      { kind: "firm_template", note: "approved" }, { kind: "__proto__" }, [], null,
    ]) {
      expect(code(() => lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Text", source: source as never }, author)), JSON.stringify(source)).toBe("bad_source");
    }
    const c = lib.createClause({ id: "cl1", kind: "liability", title: "Liability", body: "Text", source: { kind: "negotiated", ref: "LEG-1234" } }, author);
    expect(c.versions[0].provenance.source).toEqual({ kind: "negotiated", ref: "LEG-1234" });
    expect(c.versions[0].approvedBy).toBeNull();
  });
  it.each(STORES)("a store refuses a free-text source written directly (%s)", (_n, make) => {
    const { store, lib } = setup(make);
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "x", source: SRC }, author);
    const v = store.getClause(WS, "cl1")!.versions[0];
    const forged = { ...v, provenance: { ...v.provenance, source: "Approved by General Counsel" as never } };
    expect(code(() => store.insertClause(WS, { workspaceId: WS, id: "cl2", kind: "fees", title: "T", createdBy: "author-1", createdAt: "t", versions: [forged] }))).toBe("bad_source");
    lib.submit("cl1", 1, author);
    lib.approve("cl1", 1, approver);
    expect(code(() => store.saveVersion(WS, "cl1", { ...forged, version: 2 }))).toBe("bad_source");
  });
});

describe("sqlite: an old single-tenant database is refused, not mixed", () => {
  it("throws schema_mismatch on a clause table without workspace_id", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "old-")), "c.db");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE clause_library_clauses (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)");
    raw.close();
    expect(code(() => new SqliteClauseStore(file, { authorizer: new TestAuth() }))).toBe("schema_mismatch");
  });
  it("raw SQL cannot move a version to another workspace", () => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "mv-")), "c.db");
    const { lib } = setup(() => new SqliteClauseStore(file, { authorizer: new TestAuth() }));
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "x", source: SRC }, author);
    const raw = new DatabaseSync(file);
    expect(() => raw.exec("UPDATE clause_library_versions SET workspace_id='ws-b'")).toThrow(/immutable/);
    expect(() => raw.exec("UPDATE clause_library_clauses SET workspace_id='ws-b'")).toThrow(/immutable/);
    raw.close();
  });
});

describe("render-time checks still cover the new rules", () => {
  it("refuses a link or look-alike assembled from two values", () => {
    const ph = [{ path: "a", type: "text" as const }, { path: "b", type: "text" as const }];
    expect(code(() => renderBody("{{a}}{{b}}", ph, { a: "[x]", b: "(y)" }))).toBe("invalid_params");
    expect(code(() => renderBody("{{a}}{{b}}", ph, { a: "&l", b: "t;b" }))).toBe("invalid_params");
  });
});

describe("review round 1: live objects cannot answer one value to the checks and another to the write", () => {
  it("an actor with getters, a class instance or an accessor is refused, so reads cannot switch tenant", () => {
    const auth = new TestAuth({ [WS]: { "reader-1": ["viewer"], "author-1": ["editor"] }, [WS_B]: { "author-b": ["editor"] } });
    const { lib } = setup(undefined, auth);
    lib.createClause({ id: "secret-b", kind: "fees", title: "B", body: "B only", source: SRC }, as("author-b", WS_B));
    let reads = 0;
    class Shifty { id = "reader-1"; get workspaceId() { return ++reads <= 2 ? WS : WS_B; } }
    const viaGetter = { id: "reader-1", get workspaceId() { return ++reads <= 2 ? WS : WS_B; } };
    for (const actor of [new Shifty(), viaGetter, Object.create({ workspaceId: WS, id: "reader-1" })]) {
      reads = 0;
      expect(code(() => lib.get("secret-b", actor as never))).toBe("bad_actor");
      expect(code(() => lib.list(actor as never))).toBe("bad_actor");
    }
    expect(lib.list(as("reader-1")).map((c) => c.id)).toEqual([]);
    // A proxy that answers differently on every read is harmless: the library reads each field once and uses that copy.
    let calls = 0;
    const flipping = new Proxy({ workspaceId: WS, id: "reader-1" }, {
      getOwnPropertyDescriptor: (t, k) => (k === "workspaceId" ? { value: ++calls === 1 ? WS : WS_B, enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(t, k)),
      get: () => WS_B,
    });
    expect(lib.list(flipping as never).map((c) => c.id)).toEqual([]);
  });
  it.each(STORES)("a store saves exactly what it checked: getters and toJSON cannot forge the approver or author (%s)", (_n, make) => {
    const { lib, store } = setup(make);
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Own text", source: SRC }, owner);
    lib.submit("cl1", 1, owner);
    const v = store.getClause(WS, "cl1")!.versions[0];
    let n = 0;
    const flip = { ...approvalBy(v, "approver-1") } as Record<string, unknown>;
    Object.defineProperty(flip, "approvedBy", { enumerable: true, get: () => (++n <= 2 ? "approver-1" : "owner-1") });
    try { store.saveVersion(WS, "cl1", flip as never); } catch { /* refusing is fine too */ }
    const saved = store.getClause(WS, "cl1")!.versions[0];
    expect(saved.approvedBy === null || saved.approvedBy === "approver-1").toBe(true);
    // toJSON on the prototype of provenance used to hide a forged author from the comparison.
    const real = store.getClause(WS, "cl1")!.versions[0];
    if (real.state === "in_review") {
      const prov = Object.assign(Object.create({ toJSON: () => real.provenance }), { ...real.provenance, author: "approver-1" });
      expect(code(() => store.saveVersion(WS, "cl1", { ...real, provenance: prov }))).toBe("immutable");
      expect(store.getClause(WS, "cl1")!.versions[0].provenance.author).toBe("owner-1");
      expect(code(() => lib.approve("cl1", 1, owner))).toBe("self_approval");
    }
  });
  it("createClause reads each input field once, and the store checks kind and title itself", () => {
    const { lib, store } = setup();
    let n = 0;
    const input = { id: "cl1", get kind() { return ++n === 1 ? "fees" : "approved-by-gc"; }, title: "T", body: "x", source: SRC };
    const c = lib.createClause(input as never, author);
    expect(c.kind).toBe("fees");
    expect(store.getClause(WS, "cl1")!.kind).toBe("fees");
    const base = store.getClause(WS, "cl1")!;
    for (const [patch, want] of [[{ kind: "approved-by-gc" }, "bad_kind"], [{ title: "<b>x</b>" }, "bad_text"], [{ id: "../x" }, "bad_id"]] as const) {
      expect(code(() => store.insertClause(WS, { ...base, id: "cl2", ...patch } as never))).toBe(want);
    }
  });
  it.each(STORES)("a store refuses free-text or extra fields in a history entry (%s)", (_n, make) => {
    const { lib, store } = setup(make);
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "x", source: SRC }, author);
    lib.submit("cl1", 1, author);
    const v = store.getClause(WS, "cl1")!.versions[0];
    const sendBack = (extra: object) => ({ ...v, state: "draft" as const, history: [...v.history, { from: "in_review" as const, to: "draft" as const, by: "approver-1", at: "t2", ...extra }] });
    expect(code(() => store.saveVersion(WS, "cl1", sendBack({ note: "Approved by General Counsel <b>" })))).toBe("bad_text");
    expect(code(() => store.saveVersion(WS, "cl1", sendBack({ authority: "GC" })))).toBe("immutable");
    store.saveVersion(WS, "cl1", sendBack({ note: "Needs a clearer cap" }));
    expect(store.getClause(WS, "cl1")!.versions[0].state).toBe("draft");
  });
  it("transition refuses a target that is not a state name", () => {
    const { lib } = setup();
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "x", source: SRC }, owner);
    lib.submit("cl1", 1, owner);
    expect(code(() => lib.transition("cl1", 1, new String("approved") as never, owner))).toBe("bad_transition");
    expect(lib.get("cl1", reader)!.versions[0].state).toBe("in_review");
  });
});

describe("review round 1: scanner gaps and over-blocking", () => {
  it("refuses tags with boolean attributes and unclosed known elements", () => {
    for (const b of ["Acme Ltd <div hidden>", "<details open>", "<p hidden>", "x <div hidden", "<section inert>"]) expect(issueCodes(b), b).toContain("unsafe_html");
    const c = approvedClause("Client: {{name}}.");
    expect(code(() => c.use({ name: "Acme Ltd <div hidden>" }))).toBe("invalid_params");
    for (const ok of ["If a<b and c>d then", "Where x < y, then z > 3 applies.", "Clause #4: if a<b and c>d"]) expect(issueCodes(ok), ok).toEqual([]);
  });
  it("refuses link definitions inside block quotes and list items, and protocol-relative links in values", () => {
    for (const b of ["> [terms]: //evil.example.test/pay", "- [terms]: //evil.example.test", "1. [t]: https://evil.example.test", "  * > [t]: x"]) {
      expect(issueCodes(b), b).toContain("unsafe_markdown");
    }
    expect(formatValue("text", "//evil.example.test/pay").ok).toBe(false);
    expect(formatValue("text", "See (//evil.example.test)").ok).toBe(false);
    expect(formatValue("text", "Acme / Beta and/or Gamma").ok).toBe(true);
  });
  it("refuses Lisu and other look-alike scripts next to Latin, and Lisu-only imitations", () => {
    expect(issueCodes("Mꓮple pays")).toContain("unsafe_mixed_script");
    for (const v of ["ꓮꓚꓟꓰ", "ꓮꓚꓟꓰ Ltd", "Acme Ⲁⲁ Ltd"]) expect(formatValue("text", v).ok, v).toBe(false);
    for (const v of ["东京 Acme KK", "Acme א Ltd", "Müller & Fils"]) expect(formatValue("text", v).ok, v).toBe(true);
  });
  it("refuses overlay marks and the remaining fillers", () => {
    expect(issueCodes("s̶h̶a̶l̶l̶ pay")).toContain("unsafe_marks");
    expect(issueCodes("a ≠ b")).toContain("unsafe_marks");
    for (const ch of ["〿", "\u{16fe4}"]) expect(issueCodes(`a${ch}b`)).toContain("unsafe_bidi");
  });
  it("does not block data-protection drafting, only real data URLs", () => {
    for (const ok of ["Categories of personal data: name/address, email", "Personal data: contact details; usage data, logs"]) expect(issueCodes(ok), ok).toEqual([]);
    for (const b of ["data:text/html,x", "data: image/png;base64,AAAA", "data:,hello", "DATA:;base64,x"]) expect(issueCodes(b), b).toContain("unsafe_script_url");
  });
});

describe("review round 2", () => {
  it("refuses boolean attributes after a slash, among odd attribute names, and split across value and body", () => {
    for (const b of ["Acme Ltd <p/hidden>", "<foo/hidden>", "<b/hidden>", "<p x1 hidden>", "<p data_x hidden>", "<p hidden"]) expect(issueCodes(b), b).toContain("unsafe_html");
    expect(code(() => approvedClause("Client: {{name}}.").use({ name: "<b/hidden>" }))).toBe("invalid_params");
    const ph = [{ path: "a", type: "text" as const }];
    expect(code(() => renderBody("{{a}} within 5 days; fees > 0", ph, { a: "Acme <p hidden" }))).toBe("invalid_params");
    expect(code(() => renderBody("{{a}} within 5 days; fees > 0", ph, { a: "Acme <p x1 hidden" }))).toBe("invalid_params");
  });
  it("refuses link definitions with the destination on the next line or an escaped bracket in the label", () => {
    for (const b of ["[schedule]:\nhttps://evil.example.test/pay", "[a\\]b]: https://evil.example.test", "[two\nlines]: https://evil.example.test"]) {
      expect(issueCodes(b), JSON.stringify(b)).toContain("unsafe_markdown");
    }
  });
  it("refuses imitation letter forms: mathematical, full-width, Roman numeral letters and Coptic-only names", () => {
    for (const v of ["\u{1d5a0}cme Ltd", "\u{1d5a0}\u{1d5bc}\u{1d5c6}\u{1d5be}", "Ⅽeloitte", "ⲀⲂⲂ", "Ａcme"]) {
      expect(formatValue("text", v).ok, v).toBe(false);
    }
    for (const b of ["\u{1d5a0}cme pays", "Ⅽeloitte pays", "Kelvin"]) expect(issueCodes(b), b).toContain("unsafe_mixed_script");
  });
  it("accepts Latin joined to CJK, Hangul and Indic scripts, in values and at render", () => {
    const c = approvedClause("Client: {{name}}.");
    for (const name of ["LG전자", "SK하이닉스", "ABC有限公司", "Tシャツ", "Acme தமிழ் Ltd"]) {
      expect(c.use({ name }), name).toBe(`Client: ${name}.`);
    }
  });
  it.each(STORES)("a store refuses unknown fields on a clause, a version or a placeholder (%s)", (_n, make) => {
    const { lib, store } = setup(make);
    lib.createClause({ id: "cl1", kind: "fees", title: "T", body: "Pay {{n:int}}", source: SRC }, author);
    const c = store.getClause(WS, "cl1")!;
    const v = c.versions[0];
    expect(code(() => store.insertClause(WS, { ...c, id: "cl2", certification: "Approved by General Counsel" } as never))).toBe("bad_record");
    expect(code(() => store.insertClause(WS, { ...c, id: "cl3", versions: [{ ...v, approval: "GC signed off" }] } as never))).toBe("immutable");
    expect(code(() => store.saveVersion(WS, "cl1", { ...v, placeholders: [{ path: "n", type: "int", note: "GC approved" }] } as never))).toBe("immutable");
    expect(code(() => store.saveVersion(WS, "cl1", { ...v, placeholders: [{ path: "n", type: "multiline" }] }))).toBe("immutable");
    expect(code(() => store.saveVersion(WS, "cl1", { ...v, placeholders: [] }))).toBe("immutable");
    expect(lib.get("cl1", reader)).toEqual(c);
  });
  it("narrows the data: rule and covers every enclosing mark", () => {
    for (const ok of ["Personal data: audio/video recordings", "Customer data: text/voice messages"]) expect(issueCodes(ok), ok).toEqual([]);
    expect(issueCodes("data:text/html;base64,PHA+")).toContain("unsafe_script_url");
    expect(issueCodes("a᪾b")).toContain("unsafe_marks");
    expect(issueCodes("a⃝b")).toContain("unsafe_marks");
  });
});

describe("review round 3: compatibility forms that are ordinary text", () => {
  it("accepts ordinal indicators, the micro sign, ligatures, half-width kana, Indic nukta letters and the litre sign", () => {
    for (const v of ["Rua Augusta, nº 123", "1ª Vara Cível", "5 µm tolerance", "ﬁnance team", "ｶﾌﾞｼｷｶﾞｲｼｬ", "ज़मीन", "ਖ਼ਾਲਸਾ", "2 ℓ bottles"]) {
      expect(formatValue("text", v), v).toEqual({ ok: true, text: v });
    }
    expect(issueCodes("Deliver 2 ℓ per day.")).toEqual([]);
    expect(formatValue("text", "Ⅽeloitte").ok).toBe(false);
  });
});

describe("review of ead3808: only the intended compatibility forms", () => {
  it("refuses long s, digraphs, modifier and superscript letters, circled letters, and µ/ℓ/ª/º inside words", () => {
    for (const v of ["Maſter Services", "Northwind Groµp", "Acmᵉ", "ᴬcme", "Ĳsselmeer BV", "ǅakovo d.o.o.", "Ⓐcme Ltd", "Aʰ Holdings", "Smitℓ Ltd", "Joªo Lda", "Pedrº", "ANº 5", "XN.º 7"]) {
      expect(formatValue("text", v).ok, v).toBe(false);
    }
  });
  it("still accepts the intended forms", () => {
    for (const v of ["Rua Augusta, nº 123", "1ª Vara Cível", "5 µm tolerance", "5µm", "ﬁnance team", "ｶﾌﾞｼｷｶﾞｲｼｬ", "ज़मीन", "2 ℓ bottles", "N.º 7", "Acme™ Ltd", "WidgetPro℠", "20℃"]) {
      expect(formatValue("text", v), v).toEqual({ ok: true, text: v });
    }
  });
  it("stays linear on a long run of unit signs", () => {
    const t = Date.now();
    formatValue("text", "5µ".repeat(50_000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
