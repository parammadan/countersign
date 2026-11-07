// Client-side rules for the signing room: which fields the client must complete, what each one is called,
// and the same checks the server makes when the client signs (lib/files.ts completeClientSigning), so the
// client hears about a problem on the field itself instead of after pressing "Sign and finish". The server
// stays the authority; nothing here is trusted by it.
import { TYPE_LABEL, type Field } from "./fields";

type F = Pick<Field, "type" | "label" | "required">;

/** The email check the server applies to a client-filled email field. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the client has to complete: signatures and initials always, other fields when the agreement marks
 * them required. The date is never the client's to fill (the signing date is stamped), so it isn't counted. */
export const mustComplete = (f: F) => f.type !== "date" && (f.required || f.type === "signature" || f.type === "initials");

export const fieldName = (f: F) => f.label?.trim() || TYPE_LABEL[f.type];

/** What is wrong with a value the client typed or ticked, or null when the server will accept it. */
export function fieldError(f: F, value: string | boolean | undefined): string | null {
  if (f.type === "checkbox") return mustComplete(f) && value !== true ? `Tick "${fieldName(f)}" to continue.` : null;
  if (f.type === "signature" || f.type === "initials" || f.type === "date") return null;
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return mustComplete(f) ? `Fill in "${fieldName(f)}".` : null;
  if (f.type === "email" && !EMAIL_RE.test(v)) return `"${fieldName(f)}" needs a valid email, like name@example.com.`;
  return null;
}

/** A drawn mark this small (in CSS pixels) is a tap or a slip, not a signature. */
export function inkTooSmall(mode: "signature" | "initials", w: number, h: number) {
  const min = mode === "signature" ? 40 : 16;
  return Math.max(w, h) < min;
}

/** Progress through the required fields, as shown in the header and announced to screen readers. */
export function progressText(done: number, total: number, optionalLeft: number) {
  if (done < total) return `${done} of ${total} required done`;
  return optionalLeft ? `Required done · ${optionalLeft} optional` : "Ready to sign";
}

export function remainingAnnouncement(left: number) {
  return left ? `${left} required field${left === 1 ? "" : "s"} left.` : "All required fields are done. You can finish and sign.";
}

/** Browser autofill hint for a client-filled text field. */
export function autoCompleteFor(type: Field["type"]) {
  return ({ name: "name", email: "email", company: "organization", title: "organization-title" } as Partial<Record<Field["type"], string>>)[type] ?? "off";
}
