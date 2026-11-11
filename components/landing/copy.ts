// The public landing page's wording, in one place so tests can check it. Fixed text only. It describes what the
// product actually does: Claude fills in reviewed templates (it doesn't write custom agreements), answers are checked
// and cited, and signing records consent and an audit trail. No compliance claims, testimonials, logos or metrics.
import type { IconName } from "@/components/icons";
import { BRAND } from "@/lib/brand";

export const HERO = {
  eyebrow: "AI-powered agreement workspace",
  title: "From agreement to signature, all in one place.",
  subtitle:
    "Create agreements from plain English with AI, ask questions about any document, get answers across all your agreements with citations to the page, and collect electronic signatures, countersigned and filed automatically.",
} as const;

export type Feature = { id: string; icon: IconName; eyebrow: string; title: string; text: string; points: string[] };

export const FEATURES: Feature[] = [
  {
    id: "create",
    icon: "spark",
    eyebrow: "Agreement Studio",
    title: "Create with AI",
    text: "Describe the agreement you need in plain English. Claude fills in the details of one of our reviewed templates, such as the parties, fee, dates and notice period. It doesn't write a custom agreement.",
    points: [
      "Every value Claude suggests is marked until you check or change it.",
      "Edit the draft, then a second admin approves it.",
      "Export it as PDF or DOCX, or publish it for signing.",
    ],
  },
  {
    id: "understand",
    icon: "agreement",
    eyebrow: "Ask and Knowledge Hub",
    title: "Understand documents",
    text: "Ask a question about an agreement in plain English. Answers quote the passages they rely on, with page numbers, and are checked against the agreement before they're shown. If an answer can't be verified, it's withheld and you see the relevant passages instead.",
    points: [
      "Knowledge Hub: ask across all your agreements, with each answer citing the agreement and page.",
      "When nothing in your agreements supports an answer, you're told so.",
      "Answers help you read faster; they aren't legal advice.",
    ],
  },
  {
    id: "sign",
    icon: "pen",
    eyebrow: "Signing",
    title: "E-signatures",
    text: "Your client signs on any device, with no account and no download. Your firm's countersignature is applied automatically the moment they sign, and both sides get the sealed PDF with an audit certificate.",
    points: [
      "Records each signer's consent and an audit trail of every step.",
      "Anyone can check a sealed PDF on the public verify page.",
      "Reminders go out on their own, on a schedule you set.",
    ],
  },
  {
    id: "manage",
    icon: "files",
    eyebrow: "Files and records",
    title: "Agreement management",
    text: "Agreements are versioned, so every file records exactly which version was signed. Choose which agreement to send when you open a file, and see who's waiting, for how long, in one files dashboard.",
    points: [
      "Reminders, expiry and countersignature run automatically.",
      "Approvals before a new agreement goes out; resend, remind or void in one click.",
      "Signed copies and audit records stay with each file.",
      "A REST API and webhooks connect your CRM or n8n.",
    ],
  },
];

export const STEPS = [
  { title: "Create", text: "Upload the agreement you already use, or describe a new one and let Claude fill in a reviewed template." },
  { title: "Review", text: "Check every detail, edit the draft and get a second admin's approval before it's published." },
  { title: "Sign", text: "Your client signs on any device and your countersignature is applied automatically." },
  { title: "Manage", text: "Track every file, send reminders and keep the sealed PDF and audit certificate on record." },
] as const;

export const EXPLORE = {
  title: "Explore the product",
  text: "Create a free workspace and try it with your own agreements. AI features need a confirmed email address; signing, files and the verify page work right away.",
  cta: "Create a free workspace",
} as const;

export const PREVIEW_LABEL = "Illustrative preview";

export const FOOTER_NOTE = `Not legal advice. ${BRAND.name} helps you prepare, understand and sign agreements; it doesn't replace a lawyer.`;
