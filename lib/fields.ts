// Shared field schema (client + server safe).
import { z } from "zod";

export const FIELD_TYPES = ["signature", "initials", "name", "date", "title", "email", "company", "text", "checkbox"] as const;
export const ROLES = ["client", "firm", "prefill"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type Role = (typeof ROLES)[number];

export const FieldSchema = z.object({
  id: z.string().min(1).max(20),
  type: z.enum(FIELD_TYPES),
  role: z.enum(ROLES),
  page: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  label: z.string().max(120),
  required: z.boolean(),
  prefillKey: z.string().max(60).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(300).optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export type PageSize = { width: number; height: number };

export const TYPE_LABEL: Record<FieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  name: "Full name",
  date: "Date signed",
  title: "Title",
  email: "Email",
  company: "Company",
  text: "Text",
  checkbox: "Checkbox",
};

export const ROLE_LABEL: Record<Role, string> = {
  client: "Client signs",
  firm: "Your firm (auto)",
  prefill: "Filled from file",
};

export const BUILTIN_PREFILL: Record<string, string> = {
  "client.name": "Client name",
  "client.email": "Client email",
  "client.company": "Client company",
  "file.ref": "File reference",
  "file.date": "Date sent",
  "firm.legal_name": "Your firm's legal name",
};

export function customPrefillKeys(fields: Field[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const f of fields) {
    if (f.role === "prefill" && f.prefillKey?.startsWith("custom.") && !seen.has(f.prefillKey)) {
      seen.set(f.prefillKey, (f.label || f.prefillKey.slice(7)).replace(/[\s:$#]+$/, "") || f.prefillKey.slice(7));
    }
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

export function validateForPublish(fields: Field[], pages: PageSize[]): string[] {
  const errs: string[] = [];
  if (!fields.some((f) => f.role === "client" && f.type === "signature")) errs.push("Add at least one client signature field.");
  for (const f of fields) {
    const p = pages[f.page];
    if (!p) errs.push(`Field "${f.label}" is on a page that doesn't exist.`);
    else if (f.x < -1 || f.y < -1 || f.x + f.w > p.width + 1 || f.y + f.h > p.height + 1) errs.push(`Field "${f.label}" is outside the page.`);
    if (f.role === "prefill" && !f.prefillKey) errs.push(`Field "${f.label}" needs a data source.`);
    if (f.role === "prefill" && (f.type === "signature" || f.type === "initials")) errs.push(`"${f.label}": signatures can't be filled from file data.`);
  }
  return errs;
}

/** Keep a field fully on its page: size first (never larger than the page, never under 6pt), then position. */
export function clampToPage<T extends Pick<Field, "x" | "y" | "w" | "h">>(f: T, page: PageSize): T {
  const w = Math.min(Math.max(f.w, 6), page.width);
  const h = Math.min(Math.max(f.h, 6), page.height);
  return { ...f, w, h, x: Math.min(Math.max(f.x, 0), page.width - w), y: Math.min(Math.max(f.y, 0), page.height - h) };
}

/**
 * Pairs of fields on the same page that cover each other. Only counts a real overlap (more than a third of
 * the smaller box), so fields that merely touch, like a name line under a signature, aren't flagged.
 */
export function overlappingFields(fields: Field[]): [Field, Field][] {
  const out: [Field, Field][] = [];
  for (let i = 0; i < fields.length; i++)
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i], b = fields[j];
      if (a.page !== b.page) continue;
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix <= 0 || iy <= 0) continue;
      if (ix * iy > Math.min(a.w * a.h, b.w * b.h) / 3) out.push([a, b]);
    }
  return out;
}
