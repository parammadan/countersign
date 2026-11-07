import { test, expect, type APIRequestContext } from "@playwright/test";
import { adoptCountersignature, publishDraft, signAsClient, signup, uid } from "./helpers";

// The public API and the inbound webhook, end to end through HTTP: create, read, list, remind, void, and the
// error responses integrators rely on. Email isn't configured on this server, so sends are logged only.

test("REST API and inbound webhook: create, read, list, remind, void, and their errors", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  await signup(page);
  await page.goto("/app/agreements");
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  await publishDraft(page);
  await adoptCountersignature(page);

  await page.goto("/app/developers");
  await page.getByPlaceholder("Key name, e.g. CRM sync").fill("api test");
  await page.getByRole("button", { name: "Create API key" }).click();
  const key = (await page.locator("code", { hasText: /^cs_live_/ }).first().textContent())!.trim();
  const inbound = (await page.locator("code", { hasText: "/api/inbound/" }).first().textContent())!.trim();
  const auth = { Authorization: `Bearer ${key}` };
  const api = (r: APIRequestContext) => ({
    get: (p: string) => r.get(p, { headers: auth }),
    post: (p: string, data?: unknown) => r.post(p, { headers: auth, data }),
  });
  const a = api(request);

  // the agreement and its "asked when the file is created" field
  const ag = await (await a.get("/api/v1/agreements")).json();
  expect(ag.data).toHaveLength(1);
  const fee = ag.data[0].prefill_fields.find((f: { label: string }) => /fee/i.test(f.label));
  expect(fee, "the sample agreement asks for a fee").toBeTruthy();

  // create: 201, sent, prefill stored, the reference unique
  const ref = `API-${uid()}`;
  const created = await a.post("/api/v1/files", { client_name: "Jordan Sample", client_email: `client-${uid()}@example.com`, ref, prefill: { [fee.key]: "4,500" } });
  expect(created.status()).toBe(201);
  const f = await created.json();
  expect(f).toMatchObject({ status: "sent", ref, client: { name: "Jordan Sample" }, prefill: { [fee.key]: "4,500" }, ready_for_work: false });
  expect(f.signing_url).toMatch(/\/s\/[A-Za-z0-9_-]{20,}$/);
  expect((await a.post("/api/v1/files", { client_name: "Dup", client_email: `d-${uid()}@example.com`, ref })).status(), "duplicate ref").toBe(409);
  expect((await a.post("/api/v1/files", { client_name: "", client_email: "not-an-email" })).status(), "validation").toBe(422);
  expect((await request.post("/api/v1/files", { headers: { Authorization: "Bearer cs_live_wrong" }, data: {} })).status(), "bad key").toBe(401);

  // read and list
  const one = await (await a.get(`/api/v1/files/${f.id}`)).json();
  expect(one).toMatchObject({ id: f.id, status: "sent", ready_for_work: false });
  expect(Array.isArray(one.readiness)).toBe(true);
  const list = await (await a.get(`/api/v1/files?ref=${ref}`)).json();
  expect(list.data.map((x: { id: string }) => x.id)).toEqual([f.id]);
  const bad = await a.get("/api/v1/files?limit=abc");
  expect(bad.status(), "a non-numeric limit falls back to the default").toBe(200);
  expect((await bad.json()).data.length).toBeGreaterThan(0);
  expect((await (await a.get("/api/v1/files?limit=0")).json()).data).toHaveLength(1);

  // remind: counted; refused once the file is no longer open
  const reminded = await a.post(`/api/v1/files/${f.id}/remind`);
  expect(reminded.status()).toBe(200);
  expect((await reminded.json()).status).toBe("sent");

  // the client signs (prefill and all), then remind and void are refused
  const ctx = await browser.newContext();
  await signAsClient(ctx, f.signing_url);
  await ctx.close();
  const done = await (await a.get(`/api/v1/files/${f.id}`)).json();
  expect(done).toMatchObject({ status: "completed", ready_for_work: true });
  expect((await a.post(`/api/v1/files/${f.id}/remind`)).status()).toBe(409);
  expect((await a.post(`/api/v1/files/${f.id}/void`, { reason: "too late" })).status()).toBe(409);
  const doc = await request.get(`/api/v1/files/${f.id}/document`, { headers: auth });
  expect(doc.status()).toBe(200);
  expect(doc.headers()["x-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);

  // void: with a reason, with a JSON null body, and twice
  const v1 = await (await a.post("/api/v1/files", { client_name: "Casey Placeholder", client_email: `c-${uid()}@example.com`, prefill: { [fee.key]: "1" } })).json();
  const voided = await a.post(`/api/v1/files/${v1.id}/void`, { reason: "synthetic test" });
  expect(voided.status()).toBe(200);
  expect((await voided.json()).status).toBe("voided");
  expect((await a.post(`/api/v1/files/${v1.id}/void`, { reason: "again" })).status(), "already voided").toBe(409);
  const v2 = await (await a.post("/api/v1/files", { client_name: "Riley Example", client_email: `r-${uid()}@example.com`, prefill: { [fee.key]: "1" } })).json();
  const nullBody = await request.post(`/api/v1/files/${v2.id}/void`, { headers: { ...auth, "Content-Type": "application/json" }, data: "null" });
  expect(nullBody.status(), "a null JSON body voids without a reason").toBe(200);
  expect((await request.post(`/api/v1/files/${v2.id}/void`, { headers: { ...auth, "Content-Type": "application/json" }, data: '{"reason": 42}' })).status(), "already voided").toBe(409);

  // a draft through the API (send: false) can be read, and isn't sent
  const draft = await (await a.post("/api/v1/files", { client_name: "Morgan Sample", client_email: `m-${uid()}@example.com`, send: false, prefill: { [fee.key]: "1" } })).json();
  expect(draft.status).toBe("draft");

  // inbound webhook: JSON and form posts create files; an unknown token is 404
  const viaJson = await request.post(inbound, { data: { name: "Avery Example", email: `in-${uid()}@example.com`, external_ref: 12345, prefill: { [fee.key]: "2,000" } } });
  expect(viaJson.status()).toBe(201);
  expect(await viaJson.json()).toMatchObject({ status: "sent", ref: "12345", client: { name: "Avery Example" } });
  const viaForm = await request.post(inbound, { form: { client_name: "Sam Sample", client_email: `form-${uid()}@example.com` } });
  expect(viaForm.status()).toBe(201);
  expect((await request.post(inbound.replace(/[^/]+$/, "inb_not_a_real_token"), { data: { name: "x", email: "x@example.com" } })).status()).toBe(404);
  const inList = await (await a.get("/api/v1/files?ref=12345")).json();
  expect(inList.data).toHaveLength(1);
});
