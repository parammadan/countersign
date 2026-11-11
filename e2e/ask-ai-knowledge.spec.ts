import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signup, uid, uploadAndPublish } from "./helpers";
import { startMockAnthropic, type Script } from "./support/mock-anthropic";

// The Knowledge Hub (/app/knowledge) with AI answers ON, against the local mock of the Anthropic API (no network,
// no cost; see ask-ai.spec.ts). Runs in the "ai" project (the file name matches /ask-ai/).
const DUE = "each invoice is due within thirty (30) days of its date";

const answer = (o: Record<string, unknown>) => ({ status: "answered", answer: "", citations: [], ...o });
const script: Script = (q, ps) => {
  if (/invoices due/i.test(q)) {
    const due = ps.filter((p) => p.text.includes(DUE));
    return { answer: answer({ answer: "Each invoice is due within thirty (30) days of its date.", citations: due.map((p) => ({ passage: p.id, quote: DUE })) }) };
  }
  // the model itself finds nothing in what it was shown
  if (/non-compete/i.test(q)) return { answer: answer({ status: "not_found", answer: "The passages don't mention a non-compete." }) };
  return { status: 500 };
};

async function ask(page: Page, q: string) {
  await page.getByLabel("Your question").fill(q);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const entry = page.getByRole("list", { name: "Answers" }).getByRole("listitem").filter({ hasText: q }).first();
  await expect(entry).toBeVisible({ timeout: 60_000 });
  return entry;
}

async function joinAsStaff(owner: Page, browser: Browser) {
  await owner.goto("/app/settings");
  await owner.getByPlaceholder("colleague@example.com").fill(`staff-${uid()}@example.com`);
  await owner.getByLabel("Role for the new teammate").selectOption("staff");
  await owner.getByRole("button", { name: "Invite" }).click();
  const invite = (await owner.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
  const p = await (await browser.newContext()).newPage();
  await p.goto(invite);
  await p.getByLabel("Your name").fill("Sam Staff");
  await p.getByLabel("Choose a password").fill("correct-horse-42");
  await p.getByRole("button", { name: "Join workspace" }).click();
  await expect(p).toHaveURL(/\/app$/);
  return p;
}

test("Knowledge Hub with AI: index, cited answer (agreement + page), abstention, other workspaces, staff", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const mock = await startMockAnthropic(script);
  try {
    await signup(page);
    await page.goto("/app/knowledge");
    await expect(page.getByText("No agreements yet")).toBeVisible();
    await expect(page.getByText(/Answered by an AI assistant \(claude-opus-5-5\)/)).toBeVisible();

    await uploadAndPublish(page, "01-simple-one-page.pdf");
    await uploadAndPublish(page, "02-msa-two-column.pdf");

    // index everything that is published
    await page.goto("/app/knowledge");
    const agreements = page.getByRole("list", { name: "Agreements" });
    await expect(agreements.getByRole("listitem")).toHaveCount(2);
    // publishing indexed each agreement already; "Index agreements" finds nothing left to read
    await expect(page.getByText("2 of 2 agreements indexed")).toBeVisible();
    await expect(agreements.getByText(/^Indexed /)).toHaveCount(2);
    await page.getByRole("button", { name: "Index agreements" }).click();
    await expect(page).toHaveURL(/indexed=0&unchanged=2/);
    await expect(page.getByText(/Indexed 0 agreements, 2 already up to date/)).toBeVisible();
    // an admin can force one agreement to be read again
    await agreements.getByRole("listitem").first().getByRole("button", { name: "Re-index" }).click();
    await expect(page).toHaveURL(/indexed=1/);
    await expect(page.getByText(/Indexed 1 agreement, \d+ already up to date/)).toBeVisible();
    await expect(page.getByText("2 of 2 agreements indexed")).toBeVisible();
    // asking nothing yet
    await expect(page.getByText("No questions yet.")).toBeVisible();

    // an example question fills the box; the answer cites each agreement and page
    await page.getByRole("navigation", { name: "Example questions" }).getByRole("link", { name: "When are invoices due?" }).click();
    await expect(page.getByLabel("Your question")).toHaveValue("When are invoices due?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page).toHaveURL(/asked=m3q_/);
    const a1 = page.getByRole("list", { name: "Answers" }).getByRole("listitem").first();
    await expect(a1).toContainText("Answered from your agreements");
    await expect(a1).toContainText("AI assistant (claude-opus-5-5)");
    await expect(a1).toContainText("Each invoice is due within thirty (30) days of its date.");
    const sources = a1.locator("figure");
    await expect(sources).toHaveCount(2);
    await expect(sources.locator("mark").first()).toHaveText(DUE, { ignoreCase: true });
    for (const name of ["Client Services Agreement", "Master Services Agreement"]) {
      const fig = sources.filter({ has: page.getByRole("link", { name }) });
      await expect(fig).toHaveCount(1);
      await expect(fig.getByRole("link", { name: /^page \d+$/ })).toHaveAttribute("href", /\/api\/versions\/tv_[^/]+\/pdf#page=\d+$/);
    }

    // a question the agreements don't address (no passage matches): nothing is quoted
    const a2 = await ask(page, "What is the airspeed velocity of an unladen swallow?");
    await expect(a2).toContainText("Not found in your agreements");
    await expect(a2).toContainText("Your agreements don't appear to address this");
    await expect(a2.locator("figure")).toHaveCount(0);

    // the model sees passages but finds nothing: said so, and the passages are shown as written
    const a3 = await ask(page, "Is there a non-compete?");
    await expect(a3).not.toContainText("Answered from your agreements");
    await expect(a3).toContainText("The AI assistant found no answer in these passages");

    // the model was only ever given passages, with the key in the header
    expect(mock.seen.length).toBeGreaterThanOrEqual(1);
    expect(mock.seen.every((s) => s.apiKey === "test-not-a-key" && !s.verifier)).toBe(true);
    expect(mock.seen.find((s) => /invoices due/.test(s.question))).toBeTruthy();
    expect(await page.content()).not.toContain("test-not-a-key");

    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect.soft(r.violations.map((v) => `${v.id}: ${v.nodes.length}x ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);

    // another workspace sees none of it, and its own hub is empty
    const other = await (await browser.newContext()).newPage();
    await signup(other, "Southwind Partners", "Southwind Partners, LLC");
    await other.goto("/app/knowledge");
    await expect(other.getByText("No agreements yet")).toBeVisible();
    await expect(other.getByText("No questions yet.")).toBeVisible();
    const html = await other.content();
    for (const leak of ["Maple Ridge", "Client Services Agreement", "Master Services Agreement", "thirty (30) days", "unladen swallow"]) expect(html).not.toContain(leak);
    // the same question there has nothing to answer from
    const o1 = await ask(other, "When are invoices due?");
    await expect(o1).toContainText("Not found in your agreements");
    await expect(o1.locator("figure")).toHaveCount(0);
    await other.context().close();

    // staff may read and ask; only admins can force a re-read of an agreement
    const staff = await joinAsStaff(page, browser);
    await staff.goto("/app/knowledge");
    await expect(staff.getByRole("heading", { name: "Knowledge Hub", level: 1 })).toBeVisible();
    await expect(staff.getByRole("button", { name: "Index agreements" })).toBeVisible();
    await expect(staff.getByRole("button", { name: "Re-index" })).toHaveCount(0);
    await expect(staff.getByRole("list", { name: "Agreements" }).getByRole("listitem")).toHaveCount(2);
    // the team's earlier answers are visible to staff with their citations
    await expect(staff.getByRole("list", { name: "Answers" })).toContainText("When are invoices due?");
    const s1 = await ask(staff, "When are invoices due?");
    await expect(s1).toContainText("Answered from your agreements");
    await expect(s1.locator("figure")).toHaveCount(2);
    // the owner, an admin, does have the per-agreement re-index
    await page.goto("/app/knowledge");
    await expect(page.getByRole("button", { name: "Re-index" })).toHaveCount(2);
    await staff.context().close();
  } finally {
    await mock.close();
  }
});
