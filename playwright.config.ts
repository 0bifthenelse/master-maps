import { defineConfig } from "@playwright/test";

const NEXT_PORT = parseInt(process.env.NEXT_PORT || "3100", 10);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  use: {
    baseURL: `http://127.0.0.1:${NEXT_PORT}`,
    actionTimeout: 10000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // No projects defined — custom fixtures in tests/e2e/fixtures.ts
  // override page to connect to Moli CDP via chromium.connectOverCDP.
  // Never calls chromium.launch or downloads Chromium.
  // Moli serve and Next.js are started by scripts/moli/run-e2e.ts
});