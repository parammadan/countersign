// Known exposures: regression probes that script a WRONG verifier (it approves an incorrect claim, with evidence
// from another clause, a partial span, a term filed as an "absence", and so on). Before the redesign, deterministic
// rules parsed the answer's wording and sentence shape to catch these; those rules also rejected most correct answers
// (84 of 106 on sealed set 3). The redesign lets the verifier judge meaning and keeps only checks that don't read
// English, so a fooled verifier gets these through. They are measured (with an independent adversarial suite, see
// evals/adversarial/README.md), not hidden: each runs as `it.fails`, so if a change starts catching one, vitest
// reports it and it goes back to an ordinary assertion; if a change lets a NEW one through, its own test fails.
import { it } from "vitest";

export const EXPOSED = new Set<string>([
  "'15 days' judged as the payment term",
  "'15 days' quoted from the payment clause doesn't back a notice period",
  "'absence' can't carry a figure",
  "'doesn't state whether fees already paid are refundable' (they aren't)",
  "'Yes' judged as 'fees are dealt with in clause 2'",
  "a bare 'Yes.' no claim covers",
  "a calculation can't launder it either",
  "a false premise can't be judged as its correction",
  "a flipped negation can't be replaced by a corrected paraphrase",
  "a moved figure can't be covered by a different, true claim",
  "a negated clause can't be split across claims",
  "a paraphrased term with a figure from another clause",
  "a part of the answer no claim covers withholds it (a skipped sentence with a negation)",
  "a premise asked as 'how do I'",
  "a premise in a 'what happens' question",
  "a premise in an instruction",
  "a whole sentence supported with evidence that has a different figure",
  "After 15 days from giving written notice, either party may terminate. (term)",
  "Apart from fees already paid being refundable, the agreement does not say anything about refunds. (absence)",
  "At $5,000 per month, the Client's invoices are payable within 15 days.",
  "…but not with a figure the term check doubts",
  "Clause 2 does not give either party any right to terminate. (absence)",
  "Clause 2 does not include any termination right. (absence)",
  "Clause 2 does not set out any right for either party to terminate. (absence)",
  "For the $5,000 monthly bill, the Client must pay within 15 days of invoice.",
  "If you terminate, either party must give 15 days' written notice. (scenario)",
  "No clause limits or mentions the Provider's exposure for damages. (absence)",
  "Once 15 days have passed after written notice, either party may terminate. (term)",
  "only 'Fees already paid' judged in 'Fees already paid are refundable on request.'",
  "The agreement does not mention a cap, as the Provider's liability is unlimited. (absence)",
  "The agreement does not mention a refund deadline — fees already paid are refundable. (absence)",
  "The agreement does not mention a refund deadline (fees already paid are refundable on request). (absence)",
  "The agreement does not mention a refund deadline while fees already paid are refundable. (absence)",
  "The agreement does not say how notices are delivered, and either party withdraws freely. (absence)",
  "The agreement does not say how refunds are made — fees already paid are refundable. (absence)",
  "The agreement does not say how refunds are made (fees already paid are refundable). (absence)",
  "The agreement does not say how refunds are made, although the Provider refunds fees already paid. (absence)",
  "The agreement does not say how refunds are made, even though fees already paid are refundable. (absence)",
  "The agreement does not say when the Provider, which must refund fees already paid, issues refunds. (absence)",
  "The agreement does not specify a deadline for refunds and fees already paid are refundable. (absence)",
  "The agreement does not specify a deadline for refunds, and fees already paid are refundable.",
  "The agreement does not specify a refund deadline because fees already paid are refunded on request. (absence)",
  "The agreement does not specify a refund deadline, and the Provider refunds fees already paid on request. (absence)",
  "The marketing summary says otherwise but it is not binding, so fees already paid are refundable.",
  "the parties swapped",
  "the second use of a figure is checked too",
  "With 15 days' warning, either party may terminate. (term)",
  "With 15 days' written notice, either party may terminate.",
  "You must give 15 days' written notice to terminate. (scenario)"
]);

/** `it`, or `it.fails` for a probe listed above. */
export const probe = (name: string, fn: () => unknown, timeout?: number) => (EXPOSED.has(name) ? it.fails : it)(name, fn as () => Promise<void>, timeout);
