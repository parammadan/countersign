import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    // vitest 4 auto-picks a terse "agent" reporter under AI tools, which hides console output of
    // passing tests; the detector corpus test is a report, so always use the default reporter.
    reporters: ["default"],
  },
});
