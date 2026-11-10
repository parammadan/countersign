import { clauseLabel, type DraftDocument } from "./types";
import { prepareDraft } from "./validate";
import { zip } from "./zip";

const EPOCH = "1970-01-01T00:00:00Z";

// XML 1.0 forbids most control characters. validateDraft refuses them, so this strip is only a last guard
// against emitting an invalid package.
function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(text: string, rpr = ""): string {
  // Tabs/newlines inside a run become explicit elements so nothing collapses.
  const segs = text.replace(/\r\n|\r/g, "\n").split(/(\t|\n)/);
  const inner = segs
    .map((s) => (s === "\t" ? "<w:tab/>" : s === "\n" ? "<w:br/>" : s ? `<w:t xml:space="preserve">${esc(s)}</w:t>` : ""))
    .join("");
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}${inner}</w:r>`;
}

function para(runs: string, ppr = ""): string {
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${runs}</w:p>`;
}

export function renderDocx(input: DraftDocument): Uint8Array {
  const doc = prepareDraft(input);
  const body: string[] = [];
  body.push(para(run(doc.title), `<w:pStyle w:val="Title"/>`));
  if (doc.parties.length) {
    body.push(para(run("Parties"), `<w:pStyle w:val="Heading1"/>`));
    for (const p of doc.parties) body.push(para(run(`${p.role}: `, "<w:b/>") + run(p.name)));
  }
  doc.clauses.forEach((c, i) => {
    const label = clauseLabel(c, i);
    const head = c.heading ? run(`${label} ${c.heading}`, "<w:b/>") : run(label, "<w:b/>");
    body.push(para(head, `<w:keepNext/><w:spacing w:before="240" w:after="60"/>`));
    // One paragraph per source paragraph; blank lines in the text are kept as empty paragraphs.
    for (const line of c.text.split(/\r\n|\r|\n/)) body.push(para(run(line), `<w:spacing w:after="120"/>`));
  });
  // Signature block: kept together on one page (keepNext/keepLines), starts on a fresh page only if needed.
  if (doc.parties.length) body.push(para(run("Signatures"), `<w:pStyle w:val="Heading1"/><w:keepNext/><w:keepLines/>`));
  doc.parties.forEach((p, i) => {
    const last = i === doc.parties.length - 1;
    const k = last ? "<w:keepLines/>" : "<w:keepNext/><w:keepLines/>";
    body.push(para(run(`Signed for ${p.name} (${p.role})`, "<w:b/>"), `<w:keepNext/><w:keepLines/><w:spacing w:before="360"/>`));
    body.push(para(run("Signature: ______________________________"), `<w:keepNext/><w:keepLines/>`));
    body.push(para(run("Name: " + p.name), `<w:keepNext/><w:keepLines/>`));
    body.push(para(run("Date: ______________________________"), k));
  });

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>` +
    `</w:styles>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(doc.title)}</dc:title><dc:creator>doc-output</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${EPOCH}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${EPOCH}</dcterms:modified>` +
    `</cp:coreProperties>`;

  const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
  return zip([
    { name: "[Content_Types].xml", data: enc(contentTypes) },
    { name: "_rels/.rels", data: enc(rels) },
    { name: "word/document.xml", data: enc(document) },
    { name: "word/_rels/document.xml.rels", data: enc(docRels) },
    { name: "word/styles.xml", data: enc(styles) },
    { name: "docProps/core.xml", data: enc(core) },
  ]);
}
