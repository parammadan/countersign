// Realistic descriptions + realistic model outputs through cleanSuggestion: stated values survive, guesses don't.
import { describe, expect, it } from "vitest";
import { cleanSuggestion } from "@/lib/drafts/service";

const run = (desc: string, terms: [string, string][], kind = "consulting") =>
  cleanSuggestion({ kind, parties: [], terms: terms.map(([key, value]) => ({ key, value })), clarifications: [] }, desc);

describe("dates written the way people write them", () => {
  it("keeps abbreviated months and 'the 15th of January'", () => {
    expect(run("Starts Jan 15, 2027.", [["startDate", "2027-01-15"]]).terms.startDate).toBe("2027-01-15");
    expect(run("Starts 15 Sept. 2027.", [["startDate", "2027-09-15"]]).terms.startDate).toBe("2027-09-15");
    expect(run("Starts the 15th of January, 2027.", [["startDate", "2027-01-15"]]).terms.startDate).toBe("2027-01-15");
  });
  it("still drops a date the description does not write", () => {
    expect(run("Starts Jan 15, 2027.", [["startDate", "2027-01-16"]]).terms.startDate).toBeUndefined();
    expect(run("Starts Jan 2027.", [["startDate", "2027-01-01"]]).terms.startDate).toBeUndefined();
  });
});

describe("fee basis is kept only when the description says it about the fee", () => {
  it("a late-fee 'per month' does not make a one-time fee monthly", () => {
    expect(run("$12,000 one-time. Late fee 1.5% per month.", [["fee", "$12,000"], ["feeBasis", "month"]]).terms.feeBasis).toBeUndefined();
    expect(run("$12,000 flat fee. Late fee 1.5% per month.", [["feeBasis", "fixed"]]).terms.feeBasis).toBe("fixed");
  });
  it("'a fixed term of 6 months' is not a fixed fee", () => {
    expect(run("$12,000 for a fixed term of 6 months", [["feeBasis", "fixed"]]).terms.feeBasis).toBeUndefined();
  });
  it("keeps the basis when a late fee or interest is in the same sentence", () => {
    expect(run("$5,000 per month, with a 1.5% late fee.", [["feeBasis", "month"]]).terms.feeBasis).toBe("month");
    expect(run("Consulting at $4,000 a month, with interest on overdue invoices.", [["feeBasis", "month"]]).terms.feeBasis).toBe("month");
    expect(run("A $12,000 flat fee and a 1.5% monthly late fee.", [["feeBasis", "fixed"]]).terms.feeBasis).toBe("fixed");
    expect(run("A $12,000 flat fee and a 1.5% monthly late fee.", [["feeBasis", "month"]]).terms.feeBasis).toBeUndefined();
  });
  it("a month's notice is not a monthly fee", () => {
    expect(run("$5,000 total, give a month's notice", [["feeBasis", "month"]]).terms.feeBasis).toBeUndefined();
    expect(run("$5,000 a month, one month's notice", [["feeBasis", "month"]]).terms.feeBasis).toBe("month");
  });
});

describe("amounts written as shorthand", () => {
  it("accepts the exact expansion of $12k / USD 3.5k, same currency", () => {
    expect(run("Flat fee of $12k.", [["fee", "$12,000"]]).terms.fee).toBe("$12,000");
    expect(run("fee USD 3.5k", [["fee", "USD 3,500"]]).terms.fee).toBe("USD 3,500");
    expect(run("fee $1.2m", [["fee", "$1,200,000"]]).terms.fee).toBe("$1,200,000");
  });
  it("drops any other amount or currency", () => {
    expect(run("Flat fee of $12k.", [["fee", "$120,000"]]).terms.fee).toBeUndefined();
    expect(run("Flat fee of $12k.", [["fee", "$12,001"]]).terms.fee).toBeUndefined();
    expect(run("Flat fee of $12k.", [["fee", "EUR 12,000"]]).terms.fee).toBeUndefined();
    expect(run("fee $3.5k", [["fee", "$35,000"]]).terms.fee).toBeUndefined();
  });
});

describe("client owns deliverables except the consultant's tools", () => {
  const desc = "Acme Studio hires me for a flat fee $12,000. Client owns deliverables except consultant tools.";
  it("the carve-out note says the template already covers pre-existing IP, not that it is left out", () => {
    const s = cleanSuggestion({ kind: "consulting", parties: [], terms: [{ key: "ipOwner", value: "Client" }],
      clarifications: [{ key: "other", status: "not_supported", note: "The Consultant keeps its own tools." }] }, desc);
    expect(s.terms.ipOwner).toBe("Client");
    const u = s.clarifications.unsupported[0].text;
    expect(u).toMatch(/already says each party keeps/);
    expect(u).not.toMatch(/won't be in the agreement/);
  });
  it("an unrelated unsupported item still says it won't be included", () => {
    const s = cleanSuggestion({ kind: "consulting", parties: [], terms: [], clarifications: [{ key: "other", status: "not_supported", note: "A 10% referral bonus." }] }, "10% referral bonus");
    expect(s.clarifications.unsupported[0].text).toMatch(/won't be in the agreement/);
  });
});

describe("numbers attached to words", () => {
  it("takes 30 from 'net-30' and '30-day notice', and 1.5 from '1.5%'", () => {
    expect(run("Payable net-30.", [["paymentDays", "30"]], "services").terms.paymentDays).toBe("30");
    expect(run("Either side may end it on 30-day notice.", [["noticeDays", "30"]]).terms.noticeDays).toBe("30");
    expect(run("Late fee of 1.5% per month.", [["lateFeePercent", "1.5"]], "services").terms.lateFeePercent).toBe("1.5");
  });
  it("still refuses partial numbers", () => {
    expect(run("Late fee of 11.5% per month.", [["lateFeePercent", "1.5"]], "services").terms.lateFeePercent).toBeUndefined();
    expect(run("Payable net-30.", [["paymentDays", "3"]], "services").terms.paymentDays).toBeUndefined();
    expect(run("Payable net-300.", [["paymentDays", "30"]], "services").terms.paymentDays).toBeUndefined();
  });
});

describe("party names at the end of a sentence", () => {
  const parties = (desc: string, list: [string, string][], kind = "services") =>
    cleanSuggestion({ kind, parties: list.map(([role, name]) => ({ role, name })), terms: [], clarifications: [] }, desc).parties;
  it("keeps 'Bluefin Foods Inc.' when the next sentence starts right after it", () => {
    const desc = "Harbor Digital LLC will build a mobile app for Bluefin Foods Inc. Flat fee $24,000, payment due net 15.";
    expect(parties(desc, [["Provider", "Harbor Digital LLC"], ["Client", "Bluefin Foods Inc."]])).toEqual([
      { role: "Provider", name: "Harbor Digital LLC" },
      { role: "Client", name: "Bluefin Foods Inc." },
    ]);
  });
  it("still drops a name that is only part of a longer capitalised name", () => {
    expect(parties("Work for Bluefin Foods Holdings Group on the app.", [["Client", "Bluefin Foods"]])).toEqual([]);
  });
});

describe("party names in common description formats", () => {
  const P: [string, string][] = [["Provider", "Harborline Analytics LLC"], ["Client", "Evergreen Design LLC"]];
  const kept = (desc: string, list = P) =>
    cleanSuggestion({ kind: "services", parties: list.map(([role, name]) => ({ role, name })), terms: [], clarifications: [] }, desc).parties.map((p) => p.role);
  it("keeps both names written one per line, labelled, in any case", () => {
    expect(kept("Provider: Harborline Analytics LLC\nClient: Evergreen Design LLC\nFee $5,000")).toEqual(["Provider", "Client"]);
    expect(kept("PROVIDER: Harborline Analytics LLC\nCLIENT: Evergreen Design LLC")).toEqual(["Provider", "Client"]);
    expect(kept("- **Service provider:** Harborline Analytics LLC\n- **Client:** Evergreen Design LLC")).toEqual(["Provider", "Client"]);
  });
  it("keeps a name after a sentence-opening word or a party label", () => {
    expect(kept("Between Harborline Analytics LLC (Provider) and Evergreen Design LLC (Client).")).toEqual(["Provider", "Client"]);
    expect(kept("Provider Harborline Analytics LLC will work for Client Evergreen Design LLC.")).toEqual(["Provider", "Client"]);
  });
  it("still drops a name that is only part of a longer capitalised name", () => {
    expect(kept("Work for Evergreen Design LLC Holdings on the dashboards.", [["Client", "Evergreen Design LLC"]])).toEqual([]);
    expect(kept("Northern Harborline Analytics LLC will provide the services.", [["Provider", "Harborline Analytics LLC"]])).toEqual([]);
  });
});

describe("IP ownership conditions the Consulting template can't express", () => {
  const run = (desc: string, kind = "consulting") =>
    cleanSuggestion({ kind, parties: [], terms: [{ key: "ipOwner", value: "Client" }], clarifications: [] }, desc);
  const flagged = (desc: string, kind = "consulting") => run(desc, kind).clarifications.unsupported.some((u) => u.label === "Ownership only after payment");
  it("warns when ownership passes only after full payment, and still fills the owner", () => {
    const desc = "Client owns new project deliverables only after full payment. Consultant retains pre-existing IP and tools.";
    const s = run(desc);
    expect(s.terms.ipOwner).toBe("Client");
    expect(s.clarifications.unsupported.find((u) => u.label === "Ownership only after payment")!.text).toMatch(/won't be in the agreement.*Pre-existing intellectual property and tools are covered/);
    for (const d of ["Title to the deliverables transfers to the Client upon payment in full.", "Once paid in full, the client owns all work product.", "Deliverables belong to the Client subject to payment of all fees."]) expect(flagged(d), d).toBe(true);
  });
  it("says nothing when ownership has no payment condition, or for other templates", () => {
    expect(flagged("The client owns the deliverables. Payment is due in 30 days.")).toBe(false);
    expect(flagged("Client owns deliverables only after full payment.", "services")).toBe(false);
  });
  it("the template itself keeps pre-existing IP with each party and has no payment condition (what the note says)", async () => {
    const { TEMPLATES } = await import("@/lib/m23/m23-generate/templates");
    const ip = TEMPLATES.consulting.clauses.find((c: { id: string }) => c.id === "ip") as { text: string };
    expect(ip.text).toMatch(/Each party keeps the intellectual property it owned before this Agreement/);
    expect(ip.text).not.toMatch(/pay/i);
  });
});
