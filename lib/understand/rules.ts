// The built-in analyzer: deterministic reading rules, no model, no network. It reports what the text plainly
// says, quotes it, and says "not found" rather than guessing. A model provider (model.ts) can add to it later;
// both go through the same validation and evidence check.
import type { Field } from "../fields";
import type { AnalyzerOutput, Category, Evidence, Finding, Status } from "./schema";
import { INSTRUCTION_RE, normalize } from "./evidence";
import { pageText, type PageLines } from "./text";

export type RulesInput = {
  pages: PageLines[];
  title?: string | null;
  fields?: Field[];
  addedSignaturePage?: boolean;
  firmName?: string;
};

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const DATE_RE = new RegExp(
  `\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(?:${MONTHS})\\.?,?\\s+\\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{4}-\\d{2}-\\d{2})\\b`,
  "gi",
);
const BLANK_RE = /_{3,}|\.{5,}|\[\s*(?:insert|date|name|amount|fee|tbd|●|•|x+)\b[^\]]{0,30}\]|\[\s*[●•]?\s*\]|\bTBD\b|\bTBC\b|●/i;
const SIGNING_WORDS = /\b(sign|signed|signature|signatory|initials?|print(ed)? name|name|date|dated|title|position|by|email|witness)\b/i;

const FIRM_ROLE = ["provider", "service provider", "consultant", "contractor", "agency", "the agency", "firm", "vendor", "supplier", "licensor", "developer", "studio", "coach", "accountant", "accountants", "attorney", "attorneys", "counsel", "law firm", "adviser", "advisor", "planner", "trainer", "practitioner", "agent", "broker", "we", "us", "company", "photographer", "designer", "school", "tutor", "landlord"];
const CLIENT_ROLE = ["client", "customer", "buyer", "purchaser", "licensee", "subscriber", "recipient", "member", "patient", "owner", "homeowner", "you", "student", "family", "parent", "tenant", "hirer"];
const NOT_A_PARTY = ["agreement", "this agreement", "effective date", "services", "parties", "party", "term", "fees", "sow", "statement of work", "schedule", "deliverables", "confidential information", "work product", "candidate", "introduction", "terms"];

type Sentence = { page: number; text: string };

function sentences(pages: PageLines[]): Sentence[] {
  const out: Sentence[] = [];
  for (const p of pages) {
    for (const s of pageText(p).split(/(?<=[.;!?])\s+(?=[A-Z0-9("“[])/)) {
      const t = s.trim();
      if (t.length >= 3) out.push({ page: p.page, text: t });
    }
  }
  return out;
}

const quote = (page: number, text: string): Evidence => ({ page, quote: text.trim().slice(0, 300).trim() });
const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function analyzeWithRules(input: RulesInput): AnalyzerOutput {
  const findings: Finding[] = [];
  const counter = new Map<Category, number>();
  const add = (category: Category, label: string, status: Status, value: string | null, evidence: Evidence[] = [], note?: string) => {
    const n = (counter.get(category) ?? 0) + 1;
    counter.set(category, n);
    if (n > 12) return;
    findings.push({ id: `${category}-${n}`, category, label, status, value: status === "missing" ? null : value, evidence: evidence.filter((e) => e.quote.length >= 3).slice(0, 5), ...(note ? { note } : {}) });
  };
  const pages = input.pages;
  // sentences addressed to software are reported (gaps, below) and never used as a source for anything else
  const raw = sentences(pages);
  // a short "Note to the AI." heading taints the sentence that follows it too
  const tainted = new Set<number>();
  raw.forEach((s, i) => {
    if (!INSTRUCTION_RE.test(normalize(s.text))) return;
    tainted.add(i);
    if (s.text.length < 80 && raw[i + 1]?.page === s.page) tainted.add(i + 1);
  });
  const all = raw.filter((_, i) => !tainted.has(i));
  const early = all.filter((s) => s.page <= 2);

  // ---- parties ----
  const firmN = input.firmName ? normalize(input.firmName).replace(/,?\s*(llc|inc|ltd|llp|lp|plc|corp)\.?$/, "") : "";
  const partyRe = /([A-Z][A-Za-z0-9&.,'’ -]{1,90}?)\s*\(\s*(?:each\s+)?(?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?(?:the\s+)?["“]([^"”]{2,40})["”]/g;
  const parties: { name: string; term: string; role: "firm" | "client" | "other"; ev: Evidence }[] = [];
  for (const p of pages.filter((p) => p.page <= 2)) {
    const text = pageText(p);
    let m: RegExpExecArray | null;
    while ((m = partyRe.exec(text))) {
      const term = m[2].trim();
      const tl = term.toLowerCase();
      if (NOT_A_PARTY.includes(tl)) continue;
      const name = m[1]
        .split(/\b(?:by and between|between|among|and|by|with|for)\b/)
        .pop()!
        .replace(/^[\s,:;]+|[\s,:;]+$/g, "")
        .trim();
      if (name.length < 2 || /\b(agreement|letter|terms|contract)\b/i.test(name)) continue;
      if (parties.some((x) => x.term.toLowerCase() === tl)) continue;
      const role = CLIENT_ROLE.includes(tl) ? "client" : FIRM_ROLE.includes(tl) || (firmN && normalize(name).includes(firmN)) ? "firm" : "other";
      parties.push({ name, term, role, ev: quote(p.page, m[0]) });
    }
  }
  for (const x of parties) {
    const blank = BLANK_RE.test(x.name);
    const label = x.role === "client" ? "Client" : x.role === "firm" ? "Provider (your side)" : "Party";
    const ev = [x.ev];
    if (blank) add("parties", label, "missing", null, ev, `The name is left blank; it's called “${x.term}” in the agreement.`);
    else add("parties", label, "stated", `${x.name}, called “${x.term}”`, ev);
  }
  if (!parties.some((x) => x.role === "client")) {
    // "Client name: ____" style forms
    const form = all.find((s) => /\b(client|customer)('s)?\s+(legal\s+)?name\b/i.test(s.text));
    if (form && BLANK_RE.test(form.text)) add("parties", "Client", "missing", null, [quote(form.page, form.text)], "The client's name is a blank to fill in.");
    else if (!parties.length) add("parties", "Parties", "missing", null, [], "The parties aren't named in a way we could find. Check the opening paragraph and the signature blocks.");
    else add("parties", "Client", "missing", null, [], "No party is clearly identified as the client.");
  }

  // ---- type and purpose ----
  const TYPES: [RegExp, string][] = [
    [/statement of work|\bSOW\b/i, "Statement of work"],
    [/master services agreement|\bMSA\b/, "Master services agreement"],
    [/non-?disclosure|confidentiality agreement|\bNDA\b/i, "Non-disclosure agreement"],
    [/engagement letter|letter of engagement/i, "Engagement letter"],
    [/terms of business|terms and conditions|terms of service/i, "Terms of business"],
    [/retainer agreement/i, "Retainer agreement"],
    [/consult(?:ing|ancy) agreement/i, "Consulting agreement"],
    [/contractor agreement/i, "Contractor agreement"],
    [/enrol?ment (?:agreement|contract|form)/i, "Enrollment agreement"],
    [/lease agreement|rental agreement/i, "Lease"],
    [/licen[cs]e agreement/i, "Licence agreement"],
    [/subscription agreement/i, "Subscription agreement"],
    [/services? agreement|services? contract/i, "Services agreement"],
    [/\bcontract\b/i, "Contract"],
    [/\bagreement\b/i, "Agreement"],
  ];
  const head = pages[0]?.lines.slice(0, 15) ?? [];
  const typeOf = (t: string) => TYPES.find(([re]) => re.test(t))?.[1];
  const titleType = input.title ? typeOf(input.title) : undefined;
  const titleLine = input.title ? head.find((l) => normalize(l).includes(normalize(input.title!)) || normalize(input.title!).includes(normalize(l))) : undefined;
  if (input.title && titleType) add("type", "Agreement type", "stated", titleType, [quote(1, titleLine ?? input.title)], `From the title, “${clip(input.title, 90)}”.`);
  else {
    const line = head.find((l) => typeOf(l));
    if (line) add("type", "Agreement type", "inferred", typeOf(line)!, [quote(1, line)], "The document has no clear title; this is from its opening lines.");
    else add("type", "Agreement type", "missing", null, [], "No title or opening line says what kind of agreement this is.");
  }
  const purpose = early.find((s) => /\b(sets? out|describes|governs|for the provision of|(?:will|shall|agrees? to) provide|engages?\b.{0,60}\bto\b|purpose of this)\b/i.test(s.text) && s.text.length <= 400);
  if (purpose) add("type", "Purpose", "stated", clip(purpose.text), [quote(purpose.page, purpose.text)]);
  else add("type", "Purpose", "missing", null, [], "No sentence near the start says what the agreement is for.");

  // ---- dates ----
  const EFFECTIVE = /\b(effective (?:date|as of|from|on)|is dated|dated as of|made (?:on|as of|this)|entered into (?:on|as of|this)|commenc\w*|start date|begins? on|starts? on)\b/i;
  const effS = all.filter((s) => EFFECTIVE.test(s.text));
  const effDates = new Map<string, Sentence>();
  for (const s of effS) for (const d of s.text.match(DATE_RE) ?? []) if (!effDates.has(normalize(d))) effDates.set(normalize(d), s);
  const onSigning = effS.find((s) => /\bdate (?:of (?:the )?(?:last |final )?signature|(?:it|this agreement) is (?:signed|executed|accepted))|upon (?:signature|signing|execution)|when (?:signed|accepted)|last signed\b/i.test(s.text));
  if (effDates.size > 1) {
    add("dates", "Effective date", "ambiguous", [...effDates.keys()].join(" or "), [...effDates.values()].map((s) => quote(s.page, s.text)), "More than one start date appears. Check which one applies.");
  } else if (effDates.size === 1) {
    const [d, s] = [...effDates.entries()][0];
    add("dates", "Effective date", "stated", s.text.match(DATE_RE)!.find((x) => normalize(x) === d)!, [quote(s.page, s.text)]);
  } else if (onSigning) {
    add("dates", "Effective date", "stated", "When the agreement is signed", [quote(onSigning.page, onSigning.text)]);
  } else {
    const blank = effS.find((s) => BLANK_RE.test(s.text));
    if (blank) add("dates", "Effective date", "missing", null, [quote(blank.page, blank.text)], "The start date is left blank.");
    else add("dates", "Effective date", "missing", null, [], "No start or effective date was found.");
  }
  const DURATION = /\b(?:\d+|one|two|three|four|six|twelve|eighteen|twenty-four)\s*(?:\(\d+\)\s*)?(?:calendar\s+|business\s+)?(?:days?|weeks?|months?|years?)\b/i;
  const termS = all.find((s) => /\b(term of|initial term|for a (?:period|term) of|expires?|expiry|expiration|end date|ends? on|remain in (?:full )?(?:force|effect)|continues? until|until (?:terminated|completion))\b/i.test(s.text));
  if (termS) {
    const d = termS.text.match(DATE_RE)?.[0] ?? termS.text.match(DURATION)?.[0];
    const until = /until (?:terminated|completion)|continues? until/i.test(termS.text);
    add("dates", "Term or end date", d || until ? "stated" : "ambiguous", d ?? (until ? "Continues until it's ended" : clip(termS.text)), [quote(termS.page, termS.text)], d || until ? undefined : "The term is mentioned but no length or end date was found.");
  } else add("dates", "Term or end date", "missing", null, [], "No term, end date or expiry was found.");
  const renew = all.find((s) => /\b(automatic(?:ally)? renew\w*|auto-?renew\w*|renews? automatically)\b/i.test(s.text));
  if (renew) add("dates", "Automatic renewal", "stated", "Renews automatically", [quote(renew.page, renew.text)], "Check the notice needed to stop it renewing.");
  const notice = all.find((s) => /\b(?:\d+|thirty|sixty|ninety|fourteen|seven)\s*(?:\(\d+\)\s*)?days?['’]?\s*(?:prior\s+)?(?:written\s+)?notice\b/i.test(s.text));
  if (notice) add("dates", "Notice period", "stated", notice.text.match(/\b(?:\d+|thirty|sixty|ninety|fourteen|seven)\s*(?:\(\d+\)\s*)?days?/i)![0] + " notice", [quote(notice.page, notice.text)]);

  // ---- payment ----
  const PAY = /\b(fees?|pay|pays|paid|payable|payments?|invoices?d?|retainer|deposit|hourly|per hour|price|charges?d?|commission|compensation|costs?)\b/i;
  const AMOUNT = /(?:[$£€]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m)\b)?|\b(?:USD|GBP|EUR|CAD|AUD)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d+(?:\.\d+)?\s?%)/g;
  const payS = all.filter((s) => PAY.test(s.text));
  let amounts = 0;
  const LATE = /\b(late (?:fee|payment|charge)s?|interest (?:at|of|on)|accrue[sd]? interest|overdue)\b/i;
  for (const s of payS) {
    if (LATE.test(s.text)) continue; // late-payment interest is reported on its own below
    const a = [...new Set(s.text.match(AMOUNT) ?? [])];
    if (!a.length) continue;
    if (++amounts > 4) break;
    add("payment", /%/.test(a.join("")) && !/[$£€]/.test(a.join("")) ? "Fee (percentage)" : "Fee or amount", "stated", a.join(", "), [quote(s.page, s.text)]);
  }
  const blankFee = payS.find((s) => BLANK_RE.test(s.text) && !(s.text.match(AMOUNT) ?? []).length);
  if (blankFee) add("payment", "Fee left blank", "missing", null, [quote(blankFee.page, blankFee.text)], "A fee or amount is left blank.");
  // most specific first: a deadline beats "in arrears", which beats a bare frequency
  const DUE = [
    /\bnet\s?\d+\b/i,
    /\bwithin\s+(?:[a-z-]+\s+)?\(?\d+\)?\s*(?:calendar\s+|business\s+)?days(?:\s+(?:of|after|from)\s+(?:the\s+|its\s+)?[a-z]+(?:\s+date)?)?/i,
    /\b(?:due (?:on|upon) receipt|upon receipt|on receipt)\b/i,
    /\bin (?:advance|arrears)\b/i,
    /\b(?:monthly|annually|quarterly|weekly|on the \w+ (?:business )?day of each month)\b/i,
  ];
  let due: { s: Sentence; v: string } | undefined;
  for (const re of DUE) {
    const s = payS.find((x) => re.test(x.text));
    if (s) { due = { s, v: s.text.match(re)![0] }; break; }
  }
  if (due) add("payment", "When payment is due", "stated", due.v, [quote(due.s.page, due.s.text)]);
  else if (amounts) add("payment", "When payment is due", "missing", null, [], "Amounts are given, but not when they're due.");
  const late = all.find((s) => LATE.test(s.text));
  if (late) add("payment", "Late payment", "stated", clip(late.text, 160), [quote(late.page, late.text)]);
  if (!payS.length) add("payment", "Payment terms", "missing", null, [], "No fees or payment terms were found. Some agreements keep them in a separate schedule or order form.");

  // ---- obligations and key clauses ----
  const CLAUSES: [RegExp, string][] = [
    [/\bconfidential/i, "Confidentiality"],
    [/\bterminat/i, "Termination"],
    [/limitation of liability|liability (?:is|shall be|will be) limited|(?:aggregate|total|maximum) liability|in no event\b.{0,80}\bliable/i, "Limitation of liability"],
    [/\bindemnif/i, "Indemnity"],
    [/governing law|governed by (?:the )?laws?|laws of (?:the )?(?:state|commonwealth|england|province)/i, "Governing law"],
    [/\barbitrat|dispute resolution|\bmediat/i, "Disputes"],
    [/intellectual property|ownership of (?:the )?(?:work|deliverables)|\bcopyright/i, "Intellectual property"],
    [/non-?solicit|not (?:to )?solicit|non-?compet/i, "Non-solicitation or non-compete"],
    [/data protection|personal data|\bprivacy\b|\bGDPR\b|\bHIPAA\b/i, "Data protection"],
    [/\bwarrant(?:y|ies)\b/i, "Warranties"],
    [/\brefund|cancell?ation (?:fee|policy|charge)/i, "Cancellation and refunds"],
    [/\binsurance\b/i, "Insurance"],
  ];
  for (const [re, label] of CLAUSES) {
    const s = all.find((x) => re.test(x.text));
    if (s) add("obligations", label, "stated", null, [quote(s.page, s.text)]);
  }
  const partyTerms = parties.map((x) => ({ t: x.term.toLowerCase(), role: x.role }));
  const OBLIGE = /^(?:the\s+)?([A-Za-z][A-Za-z'’ -]{1,30}?)\s+(?:shall|will|must|agrees? to|is responsible for|undertakes? to)\b/i;
  const perRole = { client: 0, firm: 0 };
  for (const s of all) {
    const m = s.text.match(OBLIGE);
    if (!m || s.text.length > 400) continue;
    const who = m[1].toLowerCase().trim();
    const role = partyTerms.find((x) => x.t === who)?.role ?? (CLIENT_ROLE.includes(who) ? "client" : FIRM_ROLE.includes(who) ? "firm" : null);
    if (role !== "client" && role !== "firm") continue;
    if (perRole[role] >= 3) continue;
    perRole[role]++;
    add("obligations", role === "client" ? "Client obligation" : "Provider obligation", "stated", clip(s.text), [quote(s.page, s.text)]);
  }

  // ---- signature requirements (from the fields AgreementOS found, quoted from their captions) ----
  const fields = input.fields ?? [];
  const sigs = (role: "client" | "firm") => fields.filter((f) => f.role === role && (f.type === "signature" || f.type === "initials"));
  const caption = (fs: Field[]) => fs.map((f) => ({ page: f.page + 1, quote: f.label })).filter((e) => e.quote.trim().length >= 3);
  const where = (fs: Field[]) => [...new Set(fs.map((f) => f.page + 1))].join(", ");
  const describe = (fs: Field[]) => {
    const s = fs.filter((f) => f.type === "signature").length;
    const i = fs.length - s;
    return [s && `${s} signature${s === 1 ? "" : "s"}`, i && `${i} set${i === 1 ? "" : "s"} of initials`].filter(Boolean).join(" and ") + ` on page ${where(fs)}`;
  };
  const cs = sigs("client");
  const fs = sigs("firm");
  if (cs.length) add("signatures", "Client signs", "stated", describe(cs), caption(cs), "From the signature fields found in the document. Check them in the field editor.");
  else add("signatures", "Client signs", "missing", null, [], "No place for the client to sign was found.");
  if (fs.length) add("signatures", "Your firm signs", "stated", describe(fs), caption(fs));
  else add("signatures", "Your firm signs", "missing", null, [], "No signature line for your firm was found.");
  if (input.addedSignaturePage) add("gaps", "No signature line in the original", "missing", null, [], "The uploaded agreement had nowhere for the client to sign, so a signature page was added at the end.");
  const witness = all.find((s) => /\b(witness(?:ed)?|notari[sz]ed|notary public|in the presence of)\b/i.test(s.text));
  if (witness) add("signatures", "Witness or notary", "stated", null, [quote(witness.page, witness.text)], "AgreementOS doesn't collect witness or notary signatures. Check whether this applies.");

  // ---- gaps ----
  const unreadable = pages.filter((p) => p.textLayer === false || p.lines.length === 0).map((p) => p.page);
  if (unreadable.length) add("gaps", unreadable.length === 1 ? `Page ${unreadable[0]} has no readable text` : `Pages ${unreadable.join(", ")} have no readable text`, "missing", null, [], "It may be a scan or an image. Nothing on it was read, so check it yourself.");
  let blanks = 0;
  for (const p of pages) {
    for (const l of p.lines) {
      if (!BLANK_RE.test(l) || SIGNING_WORDS.test(l)) continue;
      if (++blanks > 6) break;
      add("gaps", "Blank left to fill in", "missing", null, [quote(p.page, l)]);
    }
  }
  const INJECTION = INSTRUCTION_RE;
  const inj = raw.find((s) => INJECTION.test(normalize(s.text)));
  if (inj) add("gaps", "Text addressed to an automated reader", "ambiguous", null, [quote(inj.page, inj.text)], "This reads like an instruction to software. It was treated as part of the document and not followed. Check why it's there.");

  return { findings };
}
