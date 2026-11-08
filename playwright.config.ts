import { defineConfig, devices } from "@playwright/test";

const external = process.env.E2E_BASE_URL;
const port = 3100;
const mailPort = 3101;
const SMTP_SINK_PORT = 2526; // e2e/support/smtp-sink.ts listens here (see mail-flow.spec.ts)

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // a focused test (.only) would silently skip the rest of the suite in CI
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: external || `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL || "chrome" }, testIgnore: /mobile|mail-flow/ },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: process.env.PW_CHANNEL || "chrome" }, testMatch: /mobile/ },
    // real SMTP delivery to a local test mail server (e2e/support/smtp-sink.ts) that can refuse recipients
    ...(external ? [] : [{ name: "mail", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL || "chrome", baseURL: `http://localhost:${mailPort}` }, testMatch: /mail-flow/ }]),
  ],
  // TRUST_PROXY=1: the test servers act as if behind a proxy, so each simulated client can arrive from its own
  // address (helpers.ts signAsClient), as real clients do. Per-IP rate limits stay exactly as in production.
  webServer: external
    ? undefined
    : [
        {
          command: `rm -rf .e2e-data && DATA_DIR=.e2e-data APP_URL=http://localhost:${port} PORT=${port} DISABLE_WORKER=1 ALLOW_PRIVATE_WEBHOOKS=1 AUTH_RATE_LIMIT_X=20 TRUST_PROXY=1 AI_PROVIDER= ANTHROPIC_API_KEY= npx next start -p ${port}`,
          url: `http://localhost:${port}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: `rm -rf .e2e-mail && DATA_DIR=.e2e-mail APP_URL=http://localhost:${mailPort} PORT=${mailPort} DISABLE_WORKER=1 AUTH_RATE_LIMIT_X=20 TRUST_PROXY=1 SMTP_HOST=127.0.0.1 SMTP_PORT=${SMTP_SINK_PORT} SMTP_USER=sink SMTP_PASS=sink EMAIL_FROM=agreements@example.com AI_PROVIDER= ANTHROPIC_API_KEY= npx next start -p ${mailPort}`,
          url: `http://localhost:${mailPort}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});
