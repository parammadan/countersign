// The public landing page's wording, in one place so tests can check it. Fixed text only. It describes what the
// product actually does: Claude fills in reviewed templates (it doesn't write custom agreements), answers are checked
// and cited, Document Intelligence reads documents with rules, and signing records consent and an audit trail. No
// compliance claims, testimonials, logos or metrics.
import type { IconName } from "@/components/icons";
import { BRAND } from "@/lib/brand";

export const HERO = {
  eyebrow: "AI-powered agreement workspace",
  titleLead: "From first draft to final signature.",
  titleAccent: "One intelligent workspace.",
  title: "From first draft to final signature. One intelligent workspace.",
  subtitle: "Create agreements with AI, understand documents, manage approvals, and send contracts for signature—all in one place.",
  primary: "Create workspace",
  caption: "Illustrative example, not a live AI response.",
  workflowLabel: "One connected workflow:",
  workflow: ["Create", "Understand", "Approve", "Sign"],
} as const;

export const NAV = {
  features: "Features",
  how: "How it works",
  verify: "Verify document",
  signIn: "Sign in",
  create: "Create workspace",
  openApp: "Open app",
} as const;

/** The sample used in every preview. Fictional names only. */
export const SAMPLE = {
  consultant: "Northwind Advisory LLC",
  client: "Acme Widgets Inc",
  description:
    "I need a consulting agreement between Northwind Advisory LLC (the consultant) and Acme Widgets Inc (the client). It's a one-time fixed fee of $12,000, and Delaware law applies.",
} as const;

export const PREVIEW_LABEL = "Illustrative preview";

export type Feature = { id: string; icon: IconName; eyebrow: string; title: string; text: string; points: readonly string[] };

export const STUDIO: Feature = {
  id: "studio",
  icon: "spark",
  eyebrow: "Agreement Studio",
  title: "Describe the agreement. Claude fills in a reviewed template.",
  text: "Describe the agreement you need in everyday language. Claude extracts the structured terms, such as the parties, fee, dates, notice period and governing law, and fills in one of the reviewed templates. It doesn't write a custom agreement.",
  points: [
    "Every value Claude suggests is marked until you check or change it.",
    "Edit the draft, then a second admin approves it.",
    "Export it as PDF or DOCX, or publish it for signing.",
  ],
};

/**
 * Document Intelligence's wording: the AI version (Claude explains one document, every point quoted and checked) or the
 * rules-only reading. This one flag switches the landing page's section, chips, badge and preview together.
 */
export const DOC_INTEL_AI = true;

export const DOC_INTEL_COPY = {
  rules: {
    id: "documents",
    icon: "agreement",
    eyebrow: "Document Intelligence",
    title: "Know what a document says before you act on it.",
    text: "Upload an incoming document and see what it is: its type, the parties, amounts, dates and governing law, each with the page it came from. Conflicting values are flagged, and text that looks like instructions aimed at an AI is quarantined and never read for a value.",
    points: [
      "Read by rules only: no AI is involved.",
      "Conflicts, missing values and warnings are listed for a person to review.",
      "When it's ready, start a pre-filled Agreement Studio draft and confirm each value.",
    ],
    badge: "Rules only: no AI",
    chips: ["Type", "Parties", "Amounts", "Dates", "Governing law", "Conflicts", "Quarantined instructions"],
  },
  ai: {
    id: "documents",
    icon: "agreement",
    eyebrow: "Document Intelligence",
    title: "Understand any document before you act on it.",
    text: "Upload a PDF or Word document and Claude explains it: an AI summary in plain English and the key terms, each cited with the passage and page it comes from and checked against the document's text. Then chat with that one document, or start an Agreement Studio draft from it.",
    points: [
      "Every point quotes its passage and page, so you can check it in the document.",
      "Chat with this one document: answers quote the passages they rely on, and one that can't be confirmed is withheld.",
      "Start a pre-filled Agreement Studio draft and check every value before you generate.",
      "Informational, not legal advice.",
    ],
    badge: "Informational, not legal advice",
    chips: ["Plain-English summary", "Key terms", "Quoted pages", "Chat with this document", "Studio draft", "Quarantined instructions"],
  },
} as const satisfies Record<"rules" | "ai", Feature & { badge: string; chips: readonly string[] }>;

export const DOC_INTEL = DOC_INTEL_AI ? DOC_INTEL_COPY.ai : DOC_INTEL_COPY.rules;

export const KNOWLEDGE: Feature = {
  id: "knowledge",
  icon: "overview",
  eyebrow: "Knowledge Hub",
  title: "Ask across every agreement. Get the passage, not a guess.",
  text: "Ask a question in plain English across your indexed agreements. Answers quote the source passages with the agreement and page, and when nothing in your agreements supports an answer, you're told so.",
  points: [
    "Ask about one agreement: answers are checked against it before they're shown, and withheld if they can't be verified.",
    "Every answer cites its passages, so you can read them yourself.",
    "Answers help you read faster; they aren't legal advice.",
  ],
};

export const SIGN: Feature = {
  id: "signatures",
  icon: "pen",
  eyebrow: "E-signatures",
  title: "Send the agreement. Get back a sealed copy anyone can verify.",
  text: "Upload the PDF or Word agreement you already use, then choose which agreement to send to each client. Your client signs on any device, your countersignature is applied automatically, and both sides get the sealed PDF with an audit certificate.",
  points: [
    "No account or download for your client.",
    "Records each signer's consent and an audit trail of every step.",
    "Anyone can check a sealed PDF on the public verify page.",
  ],
};

/** "Sign on your phone" (live): the signing page on a computer shows a QR code of the same signing link. */
export const PHONE_SIGN = {
  eyebrow: "Sign on your phone",
  title: "Started on a computer? Finish on the phone.",
  text: "On a computer, your client's signing page shows a QR code that opens the same signing link on their phone. They sign there, and the page on the computer updates by itself.",
  points: ["Scan with the phone's camera: no app to install.", "If the agreement needs an emailed code, the phone asks for it too.", "The computer shows “Signed on your phone” when they're done."],
} as const;

/**
 * Phone document scanning in the agreement upload. Not shipped yet: false keeps every mention of it off the page.
 * Flip it when "Scan with phone" is live, and check the wording against the shipped feature.
 */
export const PHONE_SCAN = false;
export const PHONE_SCAN_COPY = {
  label: "Scan with phone",
  text: "Only have it on paper? Open a QR code on your computer, photograph the pages with your phone, and they arrive as a PDF in the agreement upload, ready for the field editor.",
} as const;

/**
 * Voice input in Agreement Studio (live: the description box takes dictation, and nothing goes to Claude until the
 * person stops and checks it). false keeps every mention of it off the page.
 */
export const VOICE_INPUT = true;
export const VOICE_INPUT_COPY = {
  label: "Voice input",
  text: "Prefer to talk? Describe the agreement out loud in Agreement Studio, check the words, then let Claude fill in the template.",
} as const;

export const CLAUSES: Feature = {
  id: "clauses",
  icon: "files",
  eyebrow: "Clause Library & approvals",
  title: "Your standard wording, versioned and approved.",
  text: "Keep your firm's reusable clauses in one library. Every change is a new version, and only text a second admin has approved can be used in an agreement.",
  points: ["Every version and decision is kept.", "Placeholders for the details that change.", "Approved by a different owner or admin."],
};

export const FEATURES_INTRO = {
  eyebrow: "Features",
  title: "Everything between the first draft and the signed copy.",
  text: "Connected tools in one workspace. AI helps where it's useful, and every suggestion is yours to check before anything is sent.",
} as const;

export const FEATURES: Feature[] = [STUDIO, DOC_INTEL, KNOWLEDGE, SIGN, CLAUSES];

export const STEPS = [
  { title: "Create", icon: "spark", text: "Describe an agreement in everyday language and Claude fills in a reviewed template." },
  { title: "Understand & Review", icon: "agreement", text: "Read incoming documents, ask questions with cited answers, and check every detail of the draft." },
  { title: "Approve", icon: "checkCircle", text: "A second admin approves new agreements and clause changes before they're used." },
  { title: "Sign & Manage", icon: "pen", text: "Your client signs on any device. Countersignature, the sealed PDF and the audit certificate follow automatically." },
] as const satisfies readonly { title: string; icon: IconName; text: string }[];

export const HOW = {
  eyebrow: "How it works",
  title: "Four steps, one record.",
  note: "Already have an agreement? Upload your PDF or Word file and send it for signing — no AI needed.",
} as const;

export const CTA = {
  title: "Your next agreement starts here.",
  text: "Create a workspace and try it with your own agreements. AI features need a confirmed email address; uploading, signing and the verify page work right away.",
} as const;

export const FOOTER = {
  about: `${BRAND.name} is an agreement workspace: create agreements from reviewed templates with AI, understand documents, manage approvals and collect electronic signatures.`,
  note: `Informational, not legal advice. ${BRAND.name} helps you prepare, understand and sign agreements; it doesn't replace a lawyer.`,
} as const;
