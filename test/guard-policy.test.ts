// The merge policy's risk classification (.github/agent-guard/classify.sh): routine changes merge on green
// checks and an independent review; material ones (signing, auth, data, secrets, infrastructure, the checks
// themselves) need the owner's review; focused tests never merge. Run against fixture file lists, offline.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type File = [name: string, status?: string, previous?: string];
function classify(files: File[], added: [file: string, line: string][] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-guard-"));
  fs.writeFileSync(path.join(dir, "files.tsv"), files.map(([n, s = "modified", p = ""]) => `${n}\t${p}\t${s}`).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "added.tsv"), added.map(([f, l]) => `${f}\t${l}`).join("\n") + (added.length ? "\n" : ""));
  const out = execFileSync("bash", [".github/agent-guard/classify.sh", path.join(dir, "files.tsv"), path.join(dir, "added.tsv")], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((l) => { const [kind, reason] = l.split("\t"); return { kind, reason }; });
}
const kinds = (r: ReturnType<typeof classify>) => r.map((x) => x.kind);

describe("routine changes need no owner review", () => {
  it("UI, docs, new tests, fixtures for new work and reviewed visual baselines", () => {
    expect(classify([["components/files/FilesTabs.tsx"], ["app/app/files/page.tsx"], ["e2e/files-list.spec.ts", "added"], ["docs/API.md", "added"], ["fixtures/next/01-a.pdf", "added"], ["e2e/visual.spec.ts-snapshots/settings-desktop-darwin.png"]])).toEqual([]);
  });
  it("reading data in a workspace-scoped query is routine (writes are not)", () => {
    expect(classify([["components/outbox/query.ts", "added"]], [["components/outbox/query.ts", 'all("SELECT status, COUNT(*) AS n FROM emails WHERE workspace_id = ? GROUP BY status", ws)']])).toEqual([]);
  });
  it("the pending pull requests: Q4, Q2, Q3, Q5, Q6 and the email test are routine; Q7 touches token pages", () => {
    expect(classify([["docs/API.md", "added"], ["public/openapi.json", "added"], ["test/openapi.test.ts", "added"]])).toEqual([]);
    expect(classify([["scripts/make-next.mjs", "added"], ["fixtures/next/01.pdf", "added"], ["docs/agents/reports/Q2-detector-next.md", "added"]])).toEqual([]);
    expect(classify([["app/app/outbox/page.tsx"], ["app/app/outbox/[id]/page.tsx"], ["components/outbox/query.ts", "added"], ["e2e/outbox.spec.ts", "added"], ["test/outbox-log.test.ts", "added"]])).toEqual([]);
    expect(classify([["app/app/developers/page.tsx"], ["components/DevForms.tsx"], ["components/developers/parts.tsx", "added"], ["e2e/developers.spec.ts", "added"]])).toEqual([]);
    expect(classify([["test/brand-color.test.ts"]])).toEqual([]);
    const q7 = classify([["app/invite/[token]/page.tsx"], ["app/reset/[token]/page.tsx"], ["components/AuthForms.tsx"], ["e2e/auth-pages.spec.ts", "added"]]);
    expect(kinds(q7)).toEqual(["MATERIAL"]);
    expect(q7[0].reason).toContain("app/invite/[token]/page.tsx");
  });
});

describe("environment gating is not weakening", () => {
  it("a conditional skip with a reason (still runs in CI) is routine", () => {
    expect(classify([["e2e/outbox.spec.ts"]], [["e2e/outbox.spec.ts", '  test.skip(!!process.env.E2E_BASE_URL, "writes to the local test database");']])).toEqual([]);
  });
});

describe("material changes need the owner's review", () => {
  it.each([
    ["signature integrity", "lib/pdf/stamp.ts"],
    ["signature capture", "components/SignaturePad.tsx"],
    ["the signing page", "app/s/[token]/page.tsx"],
    ["audit evidence", "lib/audit.ts"],
    ["authentication", "lib/auth.ts"],
    ["authorization", "app/api/v1/files/route.ts"],
    ["server actions", "app/actions.ts"],
    ["production data", "lib/db.ts"],
    ["secrets", "lib/secret.ts"],
    ["infrastructure", "fly.toml"],
    ["the supply chain", "package-lock.json"],
    ["this guard", ".github/agent-guard/guard.sh"],
    ["agent rules", "CLAUDE.md"],
    ["test infrastructure", "e2e/helpers.ts"],
    ["scoring evidence", "fixtures/holdout/a.expected.json"],
  ])("%s (%s)", (_what, file) => {
    expect(kinds(classify([[file]]))).toEqual(["MATERIAL"]);
  });
  it("a rename out of a material path still counts", () => {
    expect(kinds(classify([["lib/legacy-signing.ts", "renamed", "lib/files.ts"]]))).toEqual(["MATERIAL"]);
  });
  it("database writes and schema changes anywhere outside the tests", () => {
    for (const line of ["run(\"UPDATE files SET status = 'completed' WHERE id = ?\", id)", 'db.exec("DELETE FROM emails")', "ALTER TABLE files ADD COLUMN x TEXT", "INSERT OR REPLACE INTO workspaces VALUES (?)", "CREATE INDEX i ON files(ref)"])
      expect(kinds(classify([["components/x.tsx"]], [["components/x.tsx", line]])), line).toEqual(["MATERIAL"]);
    expect(classify([["test/x.test.ts"]], [["test/x.test.ts", "db.run(\"INSERT INTO workspaces (id) VALUES ('ws_t')\")"]])).toEqual([]);
  });
  it("skipping or deleting tests", () => {
    expect(kinds(classify([["e2e/a11y.spec.ts"]], [["e2e/a11y.spec.ts", 'test.skip("public pages", async () => {})']]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([["test/flow.test.ts"]], [["test/flow.test.ts", "  it.skip(\"seals\", () => {})"]]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([["e2e/x.spec.ts"]], [["e2e/x.spec.ts", "  test.skip();"]]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([["e2e/x.spec.ts"]], [["e2e/x.spec.ts", "test.describe.skip('mail', () => {})"]]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([["e2e/security.spec.ts", "removed"]]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([["e2e/new-name.spec.ts", "renamed", "e2e/security.spec.ts"]]))).toEqual(["MATERIAL"]);
  });
});

describe("never merges as is", () => {
  it("a focused test (.only) silently skips the rest of the suite", () => {
    expect(kinds(classify([["e2e/signing-room.spec.ts"]], [["e2e/signing-room.spec.ts", 'test.only("x", async () => {})']]))).toEqual(["BLOCK"]);
  });
});
