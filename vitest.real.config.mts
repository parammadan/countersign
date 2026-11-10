// Real-model evaluation only (paid API calls). Never part of `npx vitest run` or CI: run it explicitly with
// `RUN_REAL_AI=1 npx vitest run -c vitest.real.config.mts` and the environment described in evals/real/README.md.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: { environment: "node", include: ["evals/real/**/*.test.ts"], testTimeout: 3_600_000, hookTimeout: 60_000, reporters: ["default"] },
});
