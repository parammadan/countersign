import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { DatabaseSync } from "node:sqlite";
import { signup, uid } from "./helpers";

// WCAG 2.1 A + AA rules in axe-core, as in a11y.spec.ts
async function axe(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes[0]?.target.join(" ")} | ${v.help}`);
  expect.soft(found, `${name} has accessibility violations`).toEqual([]);
}

/** Settings → Team: invite a teammate with a role, return the link the admin can copy once. */
async function inviteTeammate(page: Page, email: string, role: "staff" | "admin" = "staff") {
  await page.goto("/app/settings");
  await page.getByPlaceholder("colleague@example.com").fill(email);
  await page.getByLabel("Role for the new teammate").selectOption(role);
  await page.getByRole("button", { name: "Invite" }).click();
  const code = page.locator("code", { hasText: "/invite/" }).first();
  await expect(code).toBeVisible();
  return (await code.textContent())!.trim();
}

const inviteRow = (page: Page, email: string) => page.getByRole("listitem").filter({ hasText: email });

test("wrong password shows an error, keeps the email and marks the fields", async ({ page, browser }) => {
  const email = await signup(page);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel("Work email").fill(email);
  await p.getByLabel("Password").fill("not-the-password-1");
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(p.getByRole("alert").filter({ hasText: "Email or password" })).toContainText("Email or password is wrong.");
  await expect(p.getByLabel("Work email")).toHaveValue(email);
  await expect(p.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await ctx.close();
});

test("an unknown or used reset link says so and offers a new one", async ({ page }) => {
  await page.goto("/reset/not-a-real-token");
  await expect(page.getByRole("heading", { name: "Reset link not valid" })).toBeVisible();
  await expect(page.getByText(/invalid, has expired, or was already used/)).toBeVisible();
  await page.getByRole("link", { name: "Request a new reset link" }).click();
  await expect(page).toHaveURL(/\/forgot$/);
});

test("a valid invite can be accepted and the teammate lands signed in with the invited role", async ({ page, browser }) => {
  await signup(page);
  const email = `admin-${uid()}@example.com`;
  const invite = await inviteTeammate(page, email, "admin");
  await expect(inviteRow(page, email)).toContainText("invited · admin");

  const ctx = await browser.newContext();
  const tm = await ctx.newPage();
  await tm.goto(invite);
  await expect(tm.getByRole("heading", { name: "Join Northwind Advisory" })).toBeVisible();
  await expect(tm.getByLabel("Email")).toHaveValue(email);
  await axe(tm, "invite (valid)");
  await tm.getByLabel("Your name").fill("Sam Teammate");
  await tm.getByLabel("Choose a password").fill("correct-horse-42");
  await tm.getByRole("button", { name: "Join workspace" }).click();
  await expect(tm).toHaveURL(/\/app$/);

  // signed in as an admin: Settings (admins only) opens and shows their own row with the invited role
  await tm.goto("/app/settings");
  await expect(inviteRow(tm, email)).toContainText("admin (you)");

  // the owner sees a member with that role, and no pending invite any more
  await page.reload();
  await expect(page.getByLabel("Role for Sam Teammate")).toHaveValue("admin");
  await expect(inviteRow(page, email)).not.toContainText("invited");
  await ctx.close();
});

test("an expired invite shows the expired state with a next step, and accepting it is refused", async ({ page, browser }) => {
  await signup(page);
  const email = `late-${uid()}@example.com`;
  const invite = await inviteTeammate(page, email);

  // the teammate opens the link while it is still valid, then lets it sit
  const ctx = await browser.newContext();
  const tm = await ctx.newPage();
  await tm.goto(invite);
  await tm.getByLabel("Your name").fill("Lee Late");
  await tm.getByLabel("Choose a password").fill("correct-horse-42");

  // eight days pass (the window is seven): move the invite's date into the past, as time would
  const db = new DatabaseSync(".e2e-data/countersign.db");
  db.prepare("UPDATE invites SET created_at = ? WHERE email = ? AND accepted_at IS NULL").run(new Date(Date.now() - 8 * 86400_000).toISOString(), email);
  db.close();

  // submitting the already-open form is refused by the server
  await tm.getByRole("button", { name: "Join workspace" }).click();
  await expect(tm.getByRole("alert").filter({ hasText: "expired" })).toContainText("This invite has expired. Ask your admin for a new one.");
  await expect(tm).toHaveURL(/\/invite\//);

  // opening the link now shows the expired state instead of the form
  const fresh = await browser.newContext();
  const fp = await fresh.newPage();
  await fp.goto(invite);
  await expect(fp.getByRole("heading", { name: "Invite expired" })).toBeVisible();
  await expect(fp.getByText("This invite has expired. Ask your admin for a new one.")).toBeVisible();
  await expect(fp.getByRole("button", { name: "Join workspace" })).toHaveCount(0);
  await axe(fp, "invite (expired)");
  await fp.getByRole("link", { name: "Go to sign in" }).click();
  await expect(fp).toHaveURL(/\/login$/);

  // no account was created
  await fp.getByLabel("Work email").fill(email);
  await fp.getByLabel("Password").fill("correct-horse-42");
  await fp.getByRole("button", { name: "Sign in" }).click();
  await expect(fp.getByRole("alert").filter({ hasText: "Email or password" })).toBeVisible();

  // the owner sees it as expired, so they know to send a new one
  await page.reload();
  await expect(inviteRow(page, email)).toContainText("invite expired · staff");
  await ctx.close();
  await fresh.close();
});

test("a revoked invite shows the not-valid state, and accepting it is refused", async ({ page, browser }) => {
  await signup(page);
  const email = `revoked-${uid()}@example.com`;
  const invite = await inviteTeammate(page, email);

  const ctx = await browser.newContext();
  const tm = await ctx.newPage();
  await tm.goto(invite);
  await tm.getByLabel("Your name").fill("Rae Revoked");
  await tm.getByLabel("Choose a password").fill("correct-horse-42");

  // the owner revokes the pending invite in Settings
  await page.reload();
  await inviteRow(page, email).getByRole("button", { name: "Revoke" }).click();
  await expect(inviteRow(page, email)).toHaveCount(0);

  // revoking deletes the invite row, so the product can't tell a revoked link from a made-up one
  const db = new DatabaseSync(".e2e-data/countersign.db");
  expect(db.prepare("SELECT COUNT(*) AS n FROM invites WHERE email = ?").get(email)).toEqual({ n: 0 });
  db.close();

  await tm.getByRole("button", { name: "Join workspace" }).click();
  await expect(tm.getByRole("alert").filter({ hasText: "invite" })).toContainText("This invite link is invalid or was already used.");
  await expect(tm).toHaveURL(/\/invite\//);

  const fresh = await browser.newContext();
  const fp = await fresh.newPage();
  await fp.goto(invite);
  await expect(fp.getByRole("heading", { name: "Invite not valid" })).toBeVisible();
  await expect(fp.getByText(/invalid or has already been used/)).toBeVisible();
  await expect(fp.getByRole("button", { name: "Join workspace" })).toHaveCount(0);
  await expect(fp.getByRole("link", { name: "Go to sign in" })).toBeVisible();
  await axe(fp, "invite (revoked)");
  await ctx.close();
  await fresh.close();
});

test("a made-up invite token shows the not-valid state", async ({ page }) => {
  await page.goto(`/invite/made-up-${uid()}`);
  await expect(page.getByRole("heading", { name: "Invite not valid" })).toBeVisible();
  await expect(page.getByText(/invalid or has already been used/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Join workspace" })).toHaveCount(0);
  await axe(page, "invite (invalid)");
  await page.getByRole("link", { name: "Go to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("an already-used invite shows the invalid state with a way out", async ({ page, browser }) => {
  await signup(page);
  const invite = await inviteTeammate(page, `staff-${uid()}@example.com`);

  const ctx = await browser.newContext();
  const st = await ctx.newPage();
  await st.goto(invite);
  await st.getByLabel("Your name").fill("Sam Staff");
  await st.getByLabel("Choose a password").fill("correct-horse-42");
  await st.getByRole("button", { name: "Join workspace" }).click();
  await expect(st).toHaveURL(/\/app$/);

  const again = await browser.newContext();
  const ag = await again.newPage();
  await ag.goto(invite);
  await expect(ag.getByRole("heading", { name: "Invite not valid" })).toBeVisible();
  await expect(ag.getByText(/invalid or has already been used/)).toBeVisible();
  await expect(ag.getByRole("link", { name: "Go to sign in" })).toBeVisible();
  await axe(ag, "invite (used)");
  await ctx.close();
  await again.close();
});
