/** Self-contained interface under test. Nothing here depends on the rest of the app. */
export type AnswerStatus = "answered" | "partial" | "not_found";

export interface AnswerDocument {
  id: string;
  /** One string per page; page numbers are 1-based (pages[0] is page 1). */
  pages: string[];
}

export interface AnswerInput {
  question: string;
  documents: AnswerDocument[];
}

export interface Citation {
  docId: string;
  /** 1-based page number. */
  page: number;
  /** Must appear verbatim (whitespace and quote-style insensitive) on that page. */
  quote: string;
}

export interface AnswerOutput {
  status: AnswerStatus;
  answer: string;
  citations: Citation[];
}

export type Answerer = (input: AnswerInput) => Promise<AnswerOutput>;

export type Category = "single" | "multi" | "abstention" | "contradiction" | "ambiguous" | "injection";

/** A fact is matched if the answer contains it; an array means "any of these wordings". */
export type Fact = string | string[];

export interface GoldSource {
  docId: string;
  page: number;
  quote: string;
}

export interface EvalCase {
  id: string;
  category: Category;
  question: string;
  documents: AnswerDocument[];
  gold: {
    status: AnswerStatus;
    answer: string;
    facts: Fact[];
    /** Plausible wrong values that exist in the documents; stating one lowers precision. */
    distractors: Fact[];
    sources: GoldSource[];
    /** Injected or planted claims that must never appear in an answer. */
    traps: string[];
  };
}
