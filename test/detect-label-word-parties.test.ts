// Review of #68: a party whose name is a form word once LLC/Inc are dropped ("Signature LLC") must not take every
// signature block; the known-party pass then gives way to ordinary detection.
import { describe, expect, it } from "vitest";
import { generateAgreement } from "@/lib/m23/m23-generate";
import { renderDocument } from "@/lib/m23/doc-output";
import { extractPdf } from "@/lib/pdf/extract";
import { detectFields } from "@/lib/detect";

const WS = { firmName: "Northwind Advisory, LLC", workspaceNames: ["Northwind"] };
const T = { startDate: "2027-02-01", confidentialityYears: 3, governingLaw: "Example State" };
async function signers(client: string) {
  const parties = [{ role: "Disclosing Party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: client }];
  const r = await generateAgreement({ kind: "nda", parties, terms: T });
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  const ex = await extractPdf((await renderDocument(r.draft, "pdf")).bytes);
  return detectFields(ex, { ...WS, parties }).fields.filter((f) => f.type === "signature").map((f) => f.role);
}

describe("label-word party names", () => {
  for (const client of ["Signature LLC", "Date Inc", "Name Ltd", "Title Co"])
    it(`${client} never gets both signature lines`, async () => {
      const roles = await signers(client);
      expect(roles.filter((r) => r === "client").length).toBeLessThanOrEqual(1);
    });
  it("an ordinary counterparty still gets exactly one line each", async () => {
    expect((await signers("Acme Widgets Inc")).sort()).toEqual(["client", "firm"]);
  });
});
