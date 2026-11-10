export type DiffOp = "equal" | "insert" | "delete";
export type DiffSegment = { op: DiffOp; text: string };

/** Split into word and whitespace tokens so that joining the tokens gives back the input exactly. */
export function tokenize(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

const MAX_CELLS = 4_000_000;

/** Fallback for huge inputs: keep the common prefix and suffix, replace the middle. Still reconstructs both sides exactly. */
function coarseDiff(x: string[], y: string[]): DiffSegment[] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const seg = (op: DiffOp, t: string[]) => (t.length ? [{ op, text: t.join("") }] : []);
  return [...seg("equal", x.slice(0, p)), ...seg("delete", x.slice(p, x.length - s)), ...seg("insert", y.slice(p, y.length - s)), ...seg("equal", x.slice(x.length - s))];
}

/** Word-level diff by longest common subsequence. Joining equal+delete gives `a`; equal+insert gives `b`. */
export function diffWords(a: string, b: string): DiffSegment[] {
  const x = tokenize(a);
  const y = tokenize(b);
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_CELLS) return coarseDiff(x, y);
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffSegment[] = [];
  const push = (op: DiffOp, text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push("equal", x[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("delete", x[i++]);
    else push("insert", y[j++]);
  }
  while (i < n) push("delete", x[i++]);
  while (j < m) push("insert", y[j++]);
  return out;
}

export const originalText = (d: DiffSegment[]) => d.filter((s) => s.op !== "insert").map((s) => s.text).join("");
export const proposedText = (d: DiffSegment[]) => d.filter((s) => s.op !== "delete").map((s) => s.text).join("");
