# Branding: where the name lives, and how to change it

The public name is still **Countersign**. It changes only once the product owner picks a new one.

## Where the product name lives now

All product-name text comes from one file, `lib/brand.ts` (`BRAND.name`, `tagline`, `description`, `color`, `systemSender`). It is used by:

| Surface | File |
|---|---|
| Page titles and meta description, browser theme color | `app/layout.tsx` |
| Logo wordmark (sidebar, auth pages, landing, verify) | `components/ui.tsx` (`Logo`; the SVG mark is also there) |
| Landing page copy and footer | `app/page.tsx` |
| Signing room footer ("Secured by …") | `components/SigningRoom.tsx` |
| Verify page and verify results | `app/verify/page.tsx`, `components/VerifyForm.tsx` |
| Invite page | `app/invite/[token]/page.tsx` |
| System emails: invites, password reset, email confirmation, firm notifications, default sender, footer | `app/actions.ts`, `lib/emailverify.ts`, `lib/files.ts`, `lib/email.ts` |

Running `grep -rn '"Countersign"' app components lib` should return only `lib/brand.ts`.

**Not yet covered by the config (they are docs, not product UI):** `README.md`, `docs/*.md`, and the generated test fixtures' document metadata. Update those by hand at rename time.

## What must NOT be renamed with the brand

- **"Countersign" the verb or status** ("Firm countersigned", "Countersign and complete", the countersignature settings). This is the legal term for the second signature, not the brand.
- **API contracts:** the `X-Countersign-Signature`, `X-Countersign-Event` and `X-Countersign-Delivery` webhook headers, the `Countersign-Webhooks/1.0` user agent, `cs_live_` API keys, `cswh_` webhook secrets, `cs_*` cookies, and `public/integrations/n8n-countersign.json`. Customers' webhook verifiers and integrations depend on them. If the brand changes, add new header names alongside the old ones for a deprecation period. Don't swap them.
- **Infrastructure:** the GitHub repository, the Fly app `countersign-app`, the `countersign.db` file and the public URL.
- **Completed documents:** certificates already sealed keep the name they were sealed with. Their SHA-256 is the evidence, so rewriting them would break `/verify`. New certificates pick up the new name automatically.

## Renaming, once a name is chosen

1. Edit `lib/brand.ts` (name, tagline, description, sender), and the SVG mark in `components/ui.tsx` if the logo changes.
2. Update `README.md` and `docs/SUBMISSION.md` by hand.
3. Run `npm test`, `npm run build` and `npx playwright test`. The E2E tests don't depend on the brand name.
4. If you get a domain, set `APP_URL` and `EMAIL_FROM`. Existing signing links keep working on the old host as long as it stays up.

## Name candidates

These are checked only by a web search on 2026-11-06. **None of this is a trademark clearance**; do a USPTO/EUIPO search and a domain check before choosing.

| Name | Why it fits | What the search turned up |
|---|---|---|
| **Clausewell** | Agreements and clauses done well. Room to grow into the clause library and AI Agreement Studio (Milestone 2) without sounding like only e-signature. | Nothing found under this spelling; results were about Clausewitz. **Lowest visible conflict.** |
| **Mandato** | "Mandate" or "engagement" in Spanish, Italian and Portuguese: what a client agreement is. Short and international. | No software company found. It's a common dictionary word, so it may be hard to trademark and the obvious domains are likely taken. |
| **Pactwise** | Pact plus wise: a clear "smart agreements" signal for an AI-native product. | No exact match, but close to **PactSafe** (contract software, acquired by Ironclad). There's some risk of confusion in the same market. |
| **Parleo** | From "parley", to negotiate, which suits the conversational and voice workflows of Milestones 5 and 6. | No exact match, but very close to **Parloa**, a well-funded AI voice company. **High risk of confusion**, especially for voice features. |
| **Accordly** | "In accord": agreement reached. Friendly and easy to say. | **Conflicts found:** an early-access legal-document tool already uses the name, and a UK trademark application for ACCORDLY (SaaS, filed June 2025) exists. Not recommended. |

Also checked and rejected:
- **Retainly:** an existing CRM for service businesses that covers proposals and contracts.
- **Accordant:** an existing ERP reseller, plus a facility-software product.
- **Inkline:** several small products already use the name.

**Recommendation:** Clausewell. Mandato is the second choice, subject to trademark and domain checks.

## Design direction (for the rename and the future modules)

- **Identity:** keep the calm, document-first look: neutral greys, one strong accent, Geist type, generous whitespace. It suits a product firms trust with legal paperwork. A rename only needs a new wordmark and mark. The accent stays configurable per firm on everything clients see.
- **Navigation for future modules:** today's sidebar is Overview (Command center), Files, Agreements, Email log, Integrations & API, Settings. The planned order is:
  - Overview
  - Client Files
  - Agreements
  - AI Agreement Studio
  - Knowledge Hub
  - Document Intelligence
  - Smart Inbox
  - Automations
  - Activity & Audit
  - Integrations
  - Settings

  Modules are added to the sidebar only when they work. Nothing unfinished is shown as a link or a "coming soon" item.
