import type { DraftDocument } from "../shared/agreement-model";
import { fillTemplate, numberClauses, validateInput, type Validated } from "./build";
import { checkDraft, compareToBaseline, disguisedCharacters, scanInjection } from "./checks";
import { pdfTextProblem } from "../doc-output/pdf-text";
import { runModelStep } from "./model-step";
import type { GenerateInput, GenerateOptions, GenerateResult } from "./types";

function assemble(v: Validated, input: GenerateInput, clauses: ReturnType<typeof fillTemplate>): DraftDocument {
  return {
    schema: 1,
    title: (v.template.titleTerm && v.rendered[v.template.titleTerm]) || v.template.title,
    parties: input.parties.map((p) => ({ role: p.role, name: p.name.trim() })),
    clauses: numberClauses(clauses),
    origin: { kind: "generated" },
  };
}

/** Prompt-to-agreement generation. Never throws on bad input; never calls anything but the given provider. */
export async function generateAgreement(input: GenerateInput, options: GenerateOptions = {}): Promise<GenerateResult> {
  const v = validateInput(input);
  if (!v.template) return { status: "invalid", issues: v.issues };
  // A term the user supplied that this template cannot state is refused, never silently dropped.
  const unsupported = v.unused.map((k) => `${k}: not supported by a ${v.template.kind} agreement (it would not appear in the draft)`);
  if (v.issues.length || unsupported.length) return { status: "invalid", issues: [...v.issues, ...unsupported, ...v.missing.map((m) => `missing: ${m}`)] };
  if (v.missing.length) return { status: "needs_input", missing: v.missing, issues: [] };

  const notes: string[] = [];
  const notesText = (input.instructions ?? "").slice(0, 1000);
  const hits = [...scanInjection(notesText), ...disguisedCharacters(notesText)];
  if (hits.length) notes.push(`instructions contain instruction-like text (${hits.join(", ")}); they cannot change parties, terms or clauses`);

  // Template-only draft: the authority. Instructions never reach it.
  const baseline = fillTemplate(v, input);
  const templateDraft = assemble(v, input, baseline);
  const selfCheck = checkDraft(templateDraft, v.template, baseline, input.parties);
  // Never hand back a draft the PDF would print with "?" for some characters.
  const printProblem = pdfTextProblem(templateDraft);
  if (printProblem) selfCheck.push(`cannot be printed: ${printProblem}`);
  if (selfCheck.length) return { status: "invalid", issues: selfCheck.map((r) => `template draft failed checks: ${r}`) };

  if (!options.provider) return { status: "ok", draft: templateDraft, source: "template", fallbackReasons: [], notes, reworded: 0 };

  const step = await runModelStep(options.provider, baseline, hits.length ? undefined : input.instructions, options.timeoutMs);
  const reasons = step.ok
    ? [
        ...compareToBaseline(baseline, step.clauses, input.parties.map((p) => p.name), v.template.roles, Object.values(v.rendered)),
        ...checkDraft(assemble(v, input, step.clauses), v.template, baseline, input.parties),
        ...[pdfTextProblem(assemble(v, input, step.clauses))].filter((x): x is string => !!x).map((x) => `model output cannot be printed: ${x}`),
      ]
    : step.reasons;
  if (!step.ok || reasons.length) return { status: "ok", draft: templateDraft, source: "template", fallbackReasons: reasons, notes, reworded: 0 };
  // the AI step ran and passed; it may have found nothing to change within the rules (then the text is the template's)
  const reworded = step.clauses.filter((c, i) => c.text !== baseline[i].text).length;
  return { status: "ok", draft: assemble(v, input, step.clauses), source: "model", fallbackReasons: [], notes, reworded };
}
