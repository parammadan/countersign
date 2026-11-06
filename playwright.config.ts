import { defineConfig, devices } from "@playwright/test";

const external = process.env.E2E_BASE_URL;
const port = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: external || `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL || "chrome" }, testIgnore: /mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: process.env.PW_CHANNEL || "chrome" }, testMatch: /mobile/ },
  ],
  webServer: external
    ? undefined
    : {
        command: `rm -rf .e2e-data && DATA_DIR=.e2e-data APP_URL=http://localhost:${port} PORT=${port} DISABLE_WORKER=1 ALLOW_PRIVATE_WEBHOOKS=1 AUTH_RATE_LIMIT_X=20 npx next start -p ${port}`,
        url: `http://localhost:${port}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
