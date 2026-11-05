// Builds public/samples/sample-client-agreement.pdf: a neutral, fake engagement agreement for "try it" demos.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";

const doc = await PDFDocument.create();
const reg = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const W = 612, H = 792, M = 72;
let page = doc.addPage([W, H]);
let y = H - M;
const ink = rgb(0.1, 0.1, 0.12);
function wrap(text, font, size, maxW) {
  const out = []; let cur = "";
  for (const w of text.split(" ")) { const t = cur ? cur + " " + w : w; if (font.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
  if (cur) out.push(cur); return out;
}
function para(text, { font = reg, size = 10.5, gap = 8 } = {}) {
  for (const l of wrap(text, font, size, W - 2 * M)) { if (y < M + 40) { page = doc.addPage([W, H]); y = H - M; } page.drawText(l, { x: M, y, size, font, color: ink }); y -= size + 4; }
  y -= gap;
}
function line(label, x, yy, w) { page.drawText(label, { x, y: yy, size: 10.5, font: reg, color: ink }); page.drawText("_".repeat(Math.round(w / 5.8)), { x: x + reg.widthOfTextAtSize(label, 10.5) + 4, y: yy, size: 10.5, font: reg, color: ink }); }

para("CLIENT SERVICES AGREEMENT", { font: bold, size: 15, gap: 10 });
para("This Client Services Agreement (the \"Agreement\") is entered into as of the Effective Date below between the service provider identified in the signature block (the \"Provider\") and the client identified below (the \"Client\").");
y -= 2;
line("Client Name:", M, y, 220); y -= 22;
line("Effective Date:", M, y, 140); y -= 22;
line("Project Fee: $", M, y, 120); y -= 30;
const clauses = [
  ["1. Services.", "Provider will perform the services described in the proposal or statement of work for this engagement (the \"Services\"). Changes to scope must be agreed in writing."],
  ["2. Fees and Payment.", "Client will pay the Project Fee above. Invoices are due within fifteen (15) days of receipt. Late amounts accrue interest at 1% per month or the maximum allowed by law, if lower."],
  ["3. Client Responsibilities.", "Client will provide timely access to the information, people and systems Provider reasonably needs, and is responsible for the accuracy of the information it provides."],
  ["4. Confidentiality.", "Each party will keep the other's non-public information confidential, use it only for this Agreement, and protect it with at least reasonable care."],
  ["5. Ownership.", "On full payment, Client owns the deliverables created specifically for Client. Provider keeps its pre-existing tools, know-how and general methods."],
  ["6. Warranty and Liability.", "Provider will perform the Services in a professional and workmanlike manner. Except for confidentiality and payment obligations, each party's total liability is limited to the fees paid under this Agreement in the twelve months before the claim."],
  ["7. Term and Termination.", "Either party may end this Agreement on fourteen (14) days' written notice. Client will pay for Services performed through the termination date."],
  ["8. General.", "This Agreement is the entire agreement between the parties about its subject and may be signed electronically and in counterparts. It is governed by the laws of the state where Provider has its principal place of business."],
];
for (const [h, t] of clauses) { para(`${h} ${t}`); }
y -= 6;
if (y < 260) { page = doc.addPage([W, H]); y = H - M; }
para("IN WITNESS WHEREOF, the parties have signed this Agreement as of the Effective Date.", { gap: 14 });
const top = y;
for (const [x, head] of [[M, "SERVICE PROVIDER"], [W / 2 + 10, "CLIENT"]]) {
  let yy = top;
  page.drawText(head, { x, y: yy, size: 11, font: bold, color: ink }); yy -= 30;
  for (const r of ["Signature:", "Name:", "Title:", "Date:"]) { line(r, x, yy, 150); yy -= 26; }
}
fs.writeFileSync("public/samples/sample-client-agreement.pdf", await doc.save());
console.log("ok");
