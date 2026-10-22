import { defineConfig, devices } from "@playwright/test";

// Browser channel: the bundled Playwright Chromium by default (CI installs it via
// `playwright install --with-deps chromium`). Set PLAYWRIGHT_CHANNEL=chrome to run against a
// locally-installed Google Chrome instead; that channel is not available in CI, so it must stay
// opt-in rather than hardcoded.
const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...(channel ? { channel } : {}),
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  },
  projects: [
    {
      // Everything else - the desktop-oriented certification suite. Runs on every e2e invocation.
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-.*\.spec\.ts$/u
    },
    {
      // Mobile-view coverage (Pixel 7). Kept in dedicated `mobile-*.spec.ts` files so the
      // desktop certification sweep is not re-run under a phone viewport. Runs on the bundled
      // Chromium that CI installs, so it is always on.
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile-.*\.spec\.ts$/u
    },
    // WebKit (iPhone) coverage, opt-in via PLAYWRIGHT_MOBILE_SAFARI=1 because it needs the extra
    // `playwright install webkit` download that CI does not provision. Run it locally with:
    //   pnpm exec playwright install webkit
    //   PLAYWRIGHT_MOBILE_SAFARI=1 pnpm exec playwright test e2e/mobile-auth.spec.ts --project=mobile-safari
    ...(process.env.PLAYWRIGHT_MOBILE_SAFARI
      ? [
          {
            name: "mobile-safari",
            use: { ...devices["iPhone 13"] },
            testMatch: /mobile-.*\.spec\.ts$/u
          }
        ]
      : [])
  ],
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
