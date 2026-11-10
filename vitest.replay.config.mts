// Replay of saved real-model responses through the checks (no API calls); see evals/real/replay.test.ts.
import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({ resolve: { alias: { "@": path.resolve(import.meta.dirname) } }, test: { environment: "node", include: ["evals/real/replay.test.ts"], reporters: ["default"] } });
