const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with my our your all any each which what who how do does under during".split(" "),
);

/** Light English stemmer: possessives, plurals, -ed/-ing, -ation. Deterministic, no dependencies. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, "");
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("xes") || w.endsWith("ches") || w.endsWith("shes")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.endsWith("ation") && w.length > 8) w = w.slice(0, -5);
  else if (w.endsWith("ing") && w.length > 5) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4) w = undouble(w.slice(0, -2));
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  // terminate/terminated/termination all meet at "termin"
  if (w.endsWith("at") && w.length > 5) w = w.slice(0, -2);
  return w;
}

function undouble(w: string): string {
  return /([^aeioulsz])\1$/.test(w) ? w.slice(0, -1) : w;
}

export function tokenize(text: string, opts: { keepStop?: boolean } = {}): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  return raw
    .filter((t) => opts.keepStop || !STOP.has(t.replace(/['’]s$/, "")))
    .map(stem)
    .filter(Boolean);
}
