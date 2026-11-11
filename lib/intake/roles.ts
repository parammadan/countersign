// Which Agreement Studio role a party's role word names, for a template: shared by the rules' pre-fill
// (lib/intake/service) and Claude's draft fields (lib/intake/ai), so both group parties the same way.
import { TEMPLATES } from "../m23/m23-generate";
import type { Kind } from "../m23/m23-generate/types";

// intake role words (lower case) that name the same party as a Studio role
const ROLE_ALIAS: Record<string, string> = { provider: "Provider", "service provider": "Provider", consultant: "Provider", contractor: "Provider", client: "Client", customer: "Client", "disclosing party": "Disclosing Party", "receiving party": "Receiving Party", landlord: "Landlord", tenant: "Tenant" };

/** The template's role for a role word: its own role name, or the providing party of a template with a Client. */
export function templateRoleOf(kind: Kind, word: string): string | null {
  const roles = TEMPLATES[kind].roles;
  const w = word.trim().toLowerCase();
  const direct = roles.find((r) => r.toLowerCase() === w);
  if (direct) return direct;
  const canon = ROLE_ALIAS[w];
  if (!canon) return null;
  if (roles.includes(canon)) return canon;
  return canon === "Provider" && roles[1] === "Client" ? roles[0] : null;
}
