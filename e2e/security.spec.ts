import { test, expect, type Page } from "@playwright/test";
import { newFile, signAsClient, signup, adoptCountersignature, uid, uploadAndPublish } from "./helpers";

// HTTP-level checks: auth, sessions, roles, CSRF and isolation between workspaces.

async function apiKey(page: Page) {
  await page.goto("/app/developers");
  await page.getByPlaceholder("Key name, e.g. CRM sync").fill("test key");
  await page.getByRole("button", { name: "Create API key" }).click();
  const key = (await page.locator("code", { hasText: /^cs_live_/ }).first().textContent())!.trim();
  expect(key).toMatch(/^cs_live_/);
  return key;
}

test("signed-out requests are refused", async ({ request }) => {
  const app = await request.get("/app", { maxRedirects: 0 });
  expect(app.status()).toBe(307);
  expect(app.headers()["location"]).toContain("/login");
  expect((await request.get("/api/files/file_doesnotexist/document")).status()).toBe(401);
  expect((await request.get("/api/v1/files")).status()).toBe(401);
  expect((await request.get("/api/v1/files", { headers: { Authorization: "Bearer cs_live_notarealkey" } })).status()).toBe(401);
  expect((await request.get("/api/sign/not-a-real-token/pdf")).status()).toBe(404);
  expect((await request.post("/api/inbound/not-a-real-token", { data: { client_name: "X", client_email: "x@example.com" } })).status()).toBe(404);
});

test("wrong password is rejected and sign-out kills the session", async ({ page, browser }) => {
  const email = await signup(page);
  const cookies = await page.context().cookies();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  // replaying the old session cookie doesn't get back in
  const replay = await browser.newContext();
  await replay.addCookies(cookies);
  const r = await replay.newPage();
  await r.goto("/app");
  await expect(r).toHaveURL(/\/login/);

  await r.getByLabel("Work email").fill(email);
  await r.getByLabel("Password").fill("wrong-password-1");
  await r.getByRole("button", { name: "Sign in" }).click();
  await expect(r.getByText("Email or password is wrong.")).toBeVisible();
  await r.getByLabel("Password").fill("correct-horse-42");
  await r.getByRole("button", { name: "Sign in" }).click();
  await expect(r).toHaveURL(/\/app$/);
  await replay.close();
});

test("one workspace can't reach another's files, documents or API", async ({ page, browser }) => {
  // workspace A: a completed file
  await signup(page, "Northwind Advisory", "Northwind Advisory, LLC");
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const { fileUrl, link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });
  const fileId = new URL(fileUrl).pathname.split("/").pop()!;
  expect(fileId).toMatch(/^file_[A-Za-z0-9_-]+$/);
  const clientCtx = await browser.newContext();
  await signAsClient(clientCtx, link);
  await clientCtx.close();
  await page.goto(fileUrl);
  await expect(page.getByRole("heading", { name: "Ready for work" })).toBeVisible();
  const ownDoc = await page.request.get(`/api/files/${fileId}/document`);
  expect(ownDoc.status(), await ownDoc.text().catch(() => "")).toBe(200);
  const keyA = await apiKey(page);

  // workspace B
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await signup(b, "Fakewell Partners", "Fakewell Partners LLP");
  const keyB = await apiKey(b);

  const page404 = await b.goto(`/app/files/${fileId}`);
  expect(page404!.status()).toBe(404);
  expect((await b.request.get(`/api/files/${fileId}/document`)).status()).toBe(404);
  expect((await b.request.get(`/api/v1/files/${fileId}`, { headers: { Authorization: `Bearer ${keyB}` } })).status()).toBe(404);
  expect((await b.request.get(`/api/v1/files/${fileId}/document`, { headers: { Authorization: `Bearer ${keyB}` } })).status()).toBe(404);
  expect((await b.request.post(`/api/v1/files/${fileId}/void`, { headers: { Authorization: `Bearer ${keyB}` }, data: { reason: "x" } })).status()).toBe(404);
  const listB = await b.request.get("/api/v1/files", { headers: { Authorization: `Bearer ${keyB}` } }).then((r) => r.json());
  expect(JSON.stringify(listB)).not.toContain(fileId);

  // A's own key sees it, with the re-checked readiness
  const mine = await b.request.get(`/api/v1/files/${fileId}`, { headers: { Authorization: `Bearer ${keyA}` } }).then((r) => r.json());
  expect(mine.ready_for_work).toBe(true);
  expect(mine.readiness.every((c: { ok: boolean; required: boolean }) => c.ok || !c.required)).toBe(true);
  await ctxB.close();
});

test("cross-site requests to cookie-authenticated routes are blocked", async ({ page }) => {
  await signup(page);
  const r = await page.request.post("/api/agreements/sample", { headers: { Origin: "https://evil.example" } });
  expect(r.status()).toBe(403);
});

test("staff can open files but not change settings, keys or the team", async ({ page, browser }) => {
  await signup(page);
  await page.goto("/app/settings");
  const staffEmail = `staff-${uid()}@example.com`;
  await page.getByPlaceholder("colleague@example.com").fill(staffEmail);
  await page.getByRole("button", { name: "Invite" }).click();
  const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();

  const ctx = await browser.newContext();
  const st = await ctx.newPage();
  await st.goto(invite);
  await st.getByLabel("Your name").fill("Sam Staff");
  await st.getByLabel("Choose a password").fill("correct-horse-42");
  await st.getByRole("button", { name: "Join workspace" }).click();
  await expect(st).toHaveURL(/\/app$/);

  // the invite works once
  const again = await browser.newContext();
  const ag = await again.newPage();
  await ag.goto(invite);
  await expect(ag.getByText(/invalid or has already been used/)).toBeVisible();
  await again.close();

  // admin pages bounce staff back to the dashboard, and admin-only APIs refuse them
  await st.goto("/app/settings");
  await expect(st).toHaveURL(/\/app\?error=admin/);
  await st.goto("/app/developers");
  await expect(st).toHaveURL(/\/app\?error=admin/);
  expect((await st.request.post("/api/agreements/sample")).status()).toBe(403);
  await ctx.close();
});
