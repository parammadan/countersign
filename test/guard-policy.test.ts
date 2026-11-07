// The merge policy's risk classification (.github/agent-guard/classify.sh), offline, against fixture inputs.
// Default deny: routine only when every file is on routine-paths.txt, none is on critical-paths.txt and no
// content rule fires. Includes every bypass found by the security review of the first version.
// Test markers are assembled from parts ("." + "only") so this file doesn't trip the rules it tests.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type File = { name: string; status?: string; previous?: string; deletions?: number; patch?: boolean };
const f = (name: string, o: Omit<File, "name"> = {}): File => ({ name, ...o });
function classify(files: File[], added: [file: string, line: string][] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-guard-"));
  const rows = files.map((x) => [x.name, x.previous ?? "", x.status ?? "modified", String(x.deletions ?? 0), String(x.patch ?? true)].join("\t"));
  fs.writeFileSync(path.join(dir, "files.tsv"), rows.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "added.tsv"), added.map(([a, l]) => `${a}\t${l}`).join("\n") + (added.length ? "\n" : ""));
  const out = execFileSync("bash", [".github/agent-guard/classify.sh", path.join(dir, "files.tsv"), path.join(dir, "added.tsv")], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((l) => { const [kind, reason] = l.split("\t"); return { kind, reason }; });
}
const kinds = (r: ReturnType<typeof classify>) => [...new Set(r.map((x) => x.kind))];
const T = "test", ONLY = "only", SKIP = "skip";

describe("routine: no owner review", () => {
  it("UI pages and components, docs, static assets, new tests, fixtures for new work, visual baselines", () => {
    expect(classify([f("components/files/FilesTabs.tsx"), f("app/app/files/page.tsx"), f("e2e/files-list.spec.ts", { status: "added" }), f("test/brand-color.test.ts", { status: "added" }), f("docs/API.md", { status: "added" }), f("public/openapi.json", { status: "added" }), f("fixtures/next/01-a.pdf", { status: "added", patch: false }), f("e2e/visual.spec.ts-snapshots/settings-desktop-darwin.png", { patch: false }), f("scripts/make-next.mjs", { status: "added" })])).toEqual([]);
  });
  it("adding lines to an existing test file without deleting any", () => {
    expect(classify([f("test/brand-color.test.ts", { deletions: 0 })], [["test/brand-color.test.ts", "  expect(contrastWithWhite(bg)).toBeGreaterThanOrEqual(4.5);"]])).toEqual([]);
  });
  it("UI text that merely contains words like Delete or Update", () => {
    expect(classify([f("components/FileActions.tsx")], [["components/FileActions.tsx", '<Button variant="danger">Delete draft</Button> {"Update settings"}']])).toEqual([]);
  });
});

describe("material: default deny and critical paths", () => {
  it.each([
    "lib/util.ts", "lib/templates.ts", "lib/fields.ts", "lib/schemas.ts", "lib/detect.ts", "lib/csv.ts", "lib/errors.ts",
    "lib/dashboard.ts", "lib/library.ts", "lib/files.ts", "lib/pdf/stamp.ts", "lib/audit.ts", "lib/auth.ts", "lib/db.ts", "lib/secret.ts",
    "lib/new-helper.ts", "app/app/layout.tsx", "app/layout.tsx", "app/app/files/export2/route.ts", "app/(public)/api/v2/files/route.ts",
    "app/(signer)/s2/[token]/page.tsx", "app/s/[token]/page.tsx", "app/actions.ts", "app/reset/[token]/page.tsx",
    "components/SignaturePad.tsx", "components/SigningRoom.tsx", "components/PdfPages.tsx", "components/AuthForms.tsx", "components/ResetForms.tsx",
    "tsconfig.json", "eslint.config.mjs", ".npmrc", "package.json", "next.config.ts", "fly.toml", "Dockerfile",
    "scripts/docker-start.sh", "scripts/converter.mjs", "scripts/agents/merge.sh", "scripts/something-new.sh",
    ".github/workflows/new.yml", ".github/agent-guard/routine-paths.txt", "CLAUDE.md", "docs/agents/TASKS.md",
    "playwright.config.ts", "e2e/helpers.ts", "e2e/support/smtp-sink.ts", "test/support/seed.ts",
    "test/guard-policy.test.ts", "test/detect.test.ts", "fixtures/holdout/a.expected.json", "some-new-file.ts",
  ])("%s", (name) => {
    expect(kinds(classify([f(name)]))).toEqual(["MATERIAL"]);
  });
  it("a rename out of a material path still counts", () => {
    expect(kinds(classify([f("components/LegacySigning.tsx", { status: "renamed", previous: "components/SigningRoom.tsx" })]))).toEqual(["MATERIAL"]);
  });
});

describe("material: content of routine code", () => {
  it.each([
    ['"use server" (an inline server action)', 'async function f() { "use server"; await voidFile(ctx, id); }'],
    ["SQL reads (tenancy)", 'return all("SELECT f.client_token, u.password_hash FROM files f, users u");'],
    ["SQL split across lines", "  UPDATE files"],
    ["SQL by concatenation", '"DELETE " + "FROM files"'],
    ["REPLACE INTO", 'run("REPLACE INTO users VALUES (?)")'],
    ["PRAGMA", 'db.exec("PRAGMA foreign_keys=OFF")'],
    ["VACUUM INTO", "VACUUM INTO '/app/public/db.sqlite'"],
    ["a new import of the database", 'import { all } from "@/lib/db";'],
    ["a new import of the audit trail", "import { audit } from '@/lib/audit';"],
    ["a new relative import of signing code", 'import { voidFile } from "../../lib/files";'],
    ["a dynamic import of auth", 'const { requireSession } = await import("@/lib/auth");'],
  ])("%s", (_what, line) => {
    expect(kinds(classify([f("components/outbox/query.ts", { status: "added" })], [["components/outbox/query.ts", line]]))).toEqual(["MATERIAL"]);
  });
  it("SQL in a test file is test data, not production access", () => {
    expect(classify([f("test/x.test.ts", { status: "added" })], [["test/x.test.ts", "db.run(\"INSERT INTO workspaces (id) VALUES ('ws_t')\")"]])).toEqual([]);
  });
});

describe("material: weakening the checks", () => {
  it("any deletion in an existing test file, or removing or renaming one", () => {
    expect(kinds(classify([f("e2e/security.spec.ts", { deletions: 3 })]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([f("test/flow.test.ts", { deletions: 40 })], [["test/flow.test.ts", "export {};"]]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([f("e2e/security.spec.ts", { status: "removed", deletions: 120, patch: false })]))).toEqual(["MATERIAL"]);
    expect(kinds(classify([f("e2e/new-name.spec.ts", { status: "renamed", previous: "e2e/security.spec.ts" })]))).toEqual(["MATERIAL"]);
  });
  it.each([
    `${T}.${SKIP}(!process.env.SECURITY, "set SECURITY=1");`,
    `${T}.${SKIP}(true, "flaky");`,
    `${T}.${SKIP}(`,
    `${T}.describe.${SKIP}(() => {`,
    `${T}.fixme(true, "later");`,
    `${T}.fail();`,
    `it.fails("x", () => {});`,
    `it.todo("x");`,
    `it.${SKIP}If(true)("x", () => {});`,
    `describe.runIf(false)("x", () => {});`,
    `it.${SKIP}.each([1])("x", () => {});`,
    `xit("x", () => {});`,
  ])("%s", (line) => {
    expect(kinds(classify([f("e2e/new.spec.ts", { status: "added" })], [["e2e/new.spec.ts", line]]))).toEqual(["MATERIAL"]);
  });
});

describe("blocked: focused tests and uninspectable changes", () => {
  it.each([`${T}.${ONLY}("x", async () => {});`, `${T}.describe.serial.${ONLY}(`, `${T}.describe.parallel.${ONLY}("x", () => {})`, `${T}.${ONLY} ("x", fn)`, `${T}["${ONLY}"]("x", fn)`, `it.${ONLY}("x", fn)`, `f${"describe"}("x", fn)`])("%s", (line) => {
    expect(kinds(classify([f("e2e/new.spec.ts", { status: "added" })], [["e2e/new.spec.ts", line]]))).toContain("BLOCK");
  });
  it("a code file whose diff GitHub didn't show is material", () => {
    expect(kinds(classify([f("components/Huge.tsx", { status: "added", patch: false })]))).toEqual(["MATERIAL"]);
  });
});

describe("the open pull requests", () => {
  it("Q4 API docs and the email test are routine", () => {
    expect(classify([f("docs/API.md", { status: "added" }), f("public/openapi.json", { status: "added" }), f("test/openapi.test.ts", { status: "added" })])).toEqual([]);
    expect(classify([f("test/brand-color.test.ts")])).toEqual([]);
  });
  it("Q7's token pages are material", () => {
    expect(kinds(classify([f("app/invite/[token]/page.tsx"), f("app/reset/[token]/page.tsx")]))).toEqual(["MATERIAL"]);
  });
});
