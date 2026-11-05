import { z } from "zod";

const str = (max: number) => z.string().trim().max(max);

// Accepts both our names and common CRM/webhook names, so n8n/Zapier can post raw records.
export const NewFileBody = z
  .object({
    agreement_id: str(60).optional(),
    template_id: str(60).optional(),
    client_name: str(200).optional(),
    name: str(200).optional(),
    client_email: str(320).optional(),
    email: str(320).optional(),
    client_company: str(200).optional(),
    company: str(200).optional(),
    ref: str(120).optional(),
    external_ref: str(120).optional(),
    title: str(200).optional(),
    prefill: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
    send: z.boolean().optional(),
  })
  .transform((b, ctx) => {
    const clientName = b.client_name || b.name;
    const clientEmail = (b.client_email || b.email || "").toLowerCase();
    if (!clientName) ctx.addIssue({ code: "custom", path: ["client_name"], message: "required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) ctx.addIssue({ code: "custom", path: ["client_email"], message: "must be a valid email" });
    const prefill: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.prefill ?? {})) prefill[k.replace(/^custom\./, "")] = String(v);
    return {
      templateId: b.agreement_id || b.template_id || null,
      clientName: clientName ?? "",
      clientEmail,
      clientCompany: b.client_company || b.company || null,
      ref: b.ref || b.external_ref || null,
      title: b.title || null,
      prefill,
      send: b.send ?? true,
    };
  });
