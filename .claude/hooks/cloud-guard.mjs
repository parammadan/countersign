#!/usr/bin/env node
// PreToolUse hook for Claude Code cloud sessions only. Local sessions (CLAUDE_CODE_REMOTE unset) exit at once,
// so the owner's local development and deployment workflow is unchanged.
//
// In a cloud session it refuses production and deploy commands, pushes to main, force-pushes, merges,
// repository-settings commands, requests to production and mail hosts, reading secret or data files, and
// edits to the protected paths in .github/agent-guard/protected-paths.txt.
//
// This is friction, not the security boundary: a determined command can be spelled in ways no pattern
// catches. The boundaries are GitHub branch protection, the agent-guard check run from main, the cloud
// environment's network allowlist and secret-free configuration, and owner-only merges.
import fs from "node:fs";
import path from "node:path";

if (process.env.CLAUDE_CODE_REMOTE !== "true") process.exit(0);

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const tool = input.tool_name ?? "";
const ti = input.tool_input ?? {};
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const block = (why) => {
  process.stderr.write(`Blocked by .claude/hooks/cloud-guard.mjs (cloud agent rules in CLAUDE.md): ${why}\n`);
  process.exit(2);
};

const PRODUCTION_HOSTS = /(^|[^a-z0-9-])([a-z0-9-]+\.)*(fly\.dev|fly\.io|flyctl\.com)\b|imap\.|smtp\.|gmail\.com/i;
const SECRET_FILES = /(^|\/)(\.env(\.[^/]*)?|\.netrc|[^/]*\.(pem|key|p12|pfx|db|sqlite3?))$|(^|\/)(data|\.e2e-data|\.e2e-mail)(\/|$)/i;

function protectedRegexes() {
  try {
    return fs
      .readFileSync(path.join(root, ".github/agent-guard/protected-paths.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => new RegExp(l));
  } catch {
    return [/^\.github\//, /^\.claude\//, /^CLAUDE\.md$/]; // never fail open
  }
}
const rel = (p) => path.relative(root, path.resolve(root, String(p ?? ""))).split(path.sep).join("/");

if (tool === "Bash") {
  const cmd = String(ti.command ?? "");
  const rules = [
    [/(^|[\s;&|(`$/])(fly|flyctl)(\s|$)/, "Fly commands are owner-only (no production access for agents)."],
    [/deploy-fly\.sh/, "Deploys are owner-only."],
    [/git\b[^\n]*\bpush\b[^\n]*(\s|:)(refs\/heads\/)?main(\s|$)/, "Never push to main; open a pull request."],
    [/git\b[^\n]*\bpush\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/, "No force-pushes."],
    [/git\b[^\n]*\bpush\b[^\n]*(\s--delete\b|\s-d\b|\s:\S)/, "Don't delete remote branches."],
    [/\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*\/merge\b|\bpulls\/\d+\/merge\b/, "Agents never merge pull requests."],
    [/\bgh\s+(secret|variable|ruleset)\b|\bgh\s+api\b[^\n]*(protection|rulesets|\/secrets|\/variables|\/collaborators|\/hooks\b)/, "Repository settings, secrets and access are owner-only."],
    [/\bgh\s+api\b[^\n]*labels[^\n]*(owner-approved-paths|freeze-exception)|\b(owner-approved-paths|freeze-exception)\b[^\n]*\bgh\b/, "Owner approval labels are applied by the owner only."],
    [/\bsqlite3\b|\bfly\s+ssh\b/, "No database access."],
    [PRODUCTION_HOSTS, "No requests to the live application or mail servers."],
    [/(cat|less|more|head|tail|cp|scp|base64|xxd|strings)\s+[^\n]*(\.env\b|\.netrc|\.e2e-data|\.e2e-mail|(^|\s|\/)data\/)/, "Don't read secret or data files."],
  ];
  for (const [re, why] of rules) if (re.test(cmd)) block(why);
  process.exit(0);
}

if (tool === "WebFetch") {
  let host = "";
  try {
    host = new URL(String(ti.url ?? "")).hostname;
  } catch {}
  if (PRODUCTION_HOSTS.test(host)) block("No requests to the live application or mail servers.");
  process.exit(0);
}

if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = rel(ti.file_path ?? ti.notebook_path);
  if (SECRET_FILES.test(p)) block(`${p} is a secret or data file.`);
  if (tool !== "Read" && protectedRegexes().some((re) => re.test(p)))
    block(`${p} is a protected path (.github/agent-guard/protected-paths.txt). Stop and ask in the issue (label agent:blocked).`);
}
process.exit(0);
