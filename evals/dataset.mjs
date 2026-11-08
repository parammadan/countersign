import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DATASET_DIR = join(dirname(fileURLToPath(import.meta.url)), "datasets");
export const DATASET_FILES = ["single", "multi", "abstention", "contradiction", "ambiguous", "injection"];

/** Load all cases in a fixed order (file order, then array order). */
export function loadCases(dir = DATASET_DIR) {
  return DATASET_FILES.flatMap((f) => JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8")));
}
