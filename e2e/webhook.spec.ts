import { test, expect } from "@playwright/test";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { newFile, signup, uid, uploadAndPublish } from "./helpers";

// Needs a server started with ALLOW_PRIVATE_WEBHOOKS=1 (the local webServer is). For Docker, set
// WEBHOOK_HOST=host.docker.internal so the container can reach this test's listener.
test("outbound webhook arrives signed, through the real UI", async ({ page }) => {
  const got: { event: string; sig: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got.push({ event: String(req.headers["x-countersign-event"]), sig: String(req.headers["x-countersign-signature"]), body: b });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "0.0.0.0", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    await signup(page);
    await uploadAndPublish(page, "01-simple-one-page.pdf");
    await page.goto("/app/developers");
    await page.getByPlaceholder(/your-n8n/).fill(`http://${process.env.WEBHOOK_HOST || "localhost"}:${port}/hook`);
    await page.getByLabel("file.created").check();
    await page.getByRole("button", { name: "Add webhook" }).click();
    const secret = (await page.locator("code", { hasText: "cswh_" }).first().textContent())!.trim();
    await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });
    await expect.poll(() => got.find((g) => g.event === "file.created"), { timeout: 15_000 }).toBeTruthy();
    const h = got.find((g) => g.event === "file.created")!;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(h.sig)!;
    expect(v1).toBe(crypto.createHmac("sha256", secret).update(`${t}.${h.body}`).digest("hex"));
  } finally {
    srv.close();
  }
});
