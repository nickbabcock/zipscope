// End-to-end tests on Chromium. They run against the
// built site, served by `vite preview` with the Cloudflare plugin, which
// applies `public/_headers` as Cloudflare does.
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ZIPSCOPE_PORT ?? 4173);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  // On CI, a failed test runs one more time. The report still lists a test
  // that passes on the second run as flaky.
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? "list" : [["github"], ["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    // The UI formats numbers in the browser locale. The tests do not
    // depend on the locale of the machine. A test that checks another
    // locale sets it itself.
    locale: "en-US",
    // A production build registers the service worker after the first
    // work of the page, and it answers from its cache. Then `page.route`
    // does not see those requests, and each test would fill a cache. A spec that needs the
    // service worker (the app install and a streamed download) allows it.
    serviceWorkers: "block",
  },
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
