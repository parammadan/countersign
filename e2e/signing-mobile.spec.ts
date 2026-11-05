import { test } from "@playwright/test";
import { adoptCountersignature, newFile, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// Same grader path, entirely on a phone-sized screen (firm side and client side).
test("grader path on a phone", async ({ page, browser }) => {
  await signup(page);
  await uploadAndPublish(page, "04-defined-terms-company-client.pdf");
  await adoptCountersignature(page);
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });
  const ctx = await browser.newContext({ ...test.info().project.use });
  await signAsClient(ctx, link);
  await ctx.close();
});
