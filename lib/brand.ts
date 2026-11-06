// Product identity, in one place. Changing the product name means editing this file (and the logo mark in
// components/ui.tsx), nothing else.
//
// Deliberately NOT branding, and not to be renamed with it:
// - "countersign" as a verb or a status ("Firm countersigned"): the legal term for the second signature.
// - API contracts: X-Countersign-* webhook headers, cs_live_ API keys, cswh_ webhook secrets, cs_* cookies.
//   Integrations already depend on them; a rename would break every customer's webhook verification.
// - Infrastructure: the GitHub repo, the Fly app (countersign-app), the database file and public URLs.
// - Completed documents: certificates already sealed keep the name they were sealed with (their SHA-256 is
//   the evidence; rewriting them would break verification). The certificate itself carries no product name.
export const BRAND = {
  name: "AgreementOS",
  tagline: "Your client agreement, signed on every file. Automatically.",
  description: "Upload your client agreement once. Every new file sends it, collects the signature, countersigns and files the signed copy automatically.",
  /** default accent for new workspaces and system emails; each firm can set its own */
  color: "#1f4fd1",
  /** used as the sender name on system emails (password reset, invites, confirmations) */
  systemSender: "AgreementOS",
} as const;
