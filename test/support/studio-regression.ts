// The owner's Studio extraction regression: the description and two model answers (new shape, old failure shape).
/** The owner's regression description (verbatim). */
export const REGRESSION =
  "Consulting agreement between Northwind Advisory LLC (consultant) and Acme Widgets Inc (client). One-time fixed fee of $12,000 for the project, starting 2027-01-15. Either party may end it with 30 days' notice. Delaware law. The client owns the new project work; the consultant keeps its pre-existing IP.";
/** What Claude plausibly answers under the new prompt. */
export const NEW_ANSWER = {
  kind: "consulting",
  parties: [{ role: "Consultant", name: "Northwind Advisory LLC" }, { role: "Client", name: "Acme Widgets Inc" }],
  terms: [
    { key: "fee", value: "$12,000" }, { key: "feeBasis", value: "fixed" }, { key: "startDate", value: "2027-01-15" },
    { key: "noticeDays", value: "30" }, { key: "governingLaw", value: "Delaware" }, { key: "ipOwner", value: "Client" },
  ],
  clarifications: [
    { key: "paymentDays", status: "missing", note: "" },
    { key: "endDate", status: "missing", note: "" },
  ],
};
/** The failure the owner saw: one-time fee forced into the retainer's period, raw keys in free text. */
export const OLD_ANSWER = {
  kind: "consulting",
  parties: [{ role: "Consultant", name: "Northwind Advisory LLC" }, { role: "Client", name: "Acme Widgets Inc" }],
  terms: [
    { key: "fee", value: "$12,000" }, { key: "feePeriod", value: "one-time" }, { key: "startDate", value: "2027-01-15" },
    { key: "noticeDays", value: "30" }, { key: "governingLaw", value: "Delaware" }, { key: "ipOwner", value: "Client owns new work; Consultant retains pre-existing IP" },
  ],
  unclear: ["feePeriod: one-time fixed fee is not a valid period", "ipOwner: split ownership could not fit", "paymentDays not stated"],
};
