import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: "chrome",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  },
  webServer: {
    command: "pnpm --filter @grogoni/web dev",
    env: {
      VITE_INFERENCE_CLIENT_FIRST: "true",
      VITE_INFERENCE_CLOUD_FALLBACK_ENABLED: "true"
    },
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000
  }
});
