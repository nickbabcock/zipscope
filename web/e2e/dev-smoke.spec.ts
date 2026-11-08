// The four sample controls under the development server. Only a development
// build of Solid has the guards that find a signal write in a component body,
// and the other specs run against the production build. A write of this kind
// halts the app in development and has no effect in production, so only this
// spec can see it.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { waitForOutcome } from "./listing";

/** Returns a free port of the OS, so that a run clashes with nothing. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("The OS gave no port"));
      });
    });
  });
}

/** A warning of the tool that this spec does not judge: `onCleanup` in a `ref`
 *  of the breadcrumb and the strip. It does not stop the app. */
const KNOWN = /^\[NO_OWNER_CLEANUP\]/;

test.describe.configure({ mode: "serial", timeout: 180_000 });

let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  base = `http://localhost:${port}/`;
  const child = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort"], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    env: { ...process.env, ZIPSCOPE_DEV_PORT: String(port) },
  });
  server = child;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let exited = "";
  child.once("exit", (code, signal) => (exited = `code ${code ?? signal}`));
  child.once("error", (error) => (exited = error.message));
  const end = Date.now() + 110_000;
  for (;;) {
    if (exited !== "") {
      throw new Error(`vite stopped on port ${port} before it served (${exited}):\n${stderr}`);
    }
    if (Date.now() > end) {
      throw new Error(`vite did not serve on port ${port} in 110 s:\n${stderr}`);
    }
    const status = await fetch(base, { signal: AbortSignal.timeout(5000) }).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

test.afterAll(() => {
  // The server has its own process group, with its child processes. The group
  // can be gone already, and that is not a failure of a test.
  if (server?.pid === undefined) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
});

for (const id of ["see-contents", "see-space", "see-health", "sample-button"]) {
  test(`${id} opens the sample with no new warning of the reactive system`, async ({ page }) => {
    const messages: string[] = [];
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        messages.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.locator(`#${id}`).click({ timeout: 60_000 });
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await expect(page.locator("#panes")).toBeVisible();
    expect(messages.filter((text) => /^\[[A-Z_]+\]/.test(text) && !KNOWN.test(text))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("a search, a header click and a clear give no new warning of the reactive system", async ({
  page,
}) => {
  const messages: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      messages.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator("#see-contents").click({ timeout: 60_000 });
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const search = page.locator("#search-input");
  await search.fill("a");
  await expect(page.locator("#sort-status")).toHaveText("Best match");
  // Enter selects the first result and moves the focus to the table.
  await search.press("Enter");
  await expect(page.locator("#list-viewport")).toBeFocused();
  await page.locator("[role=columnheader][data-column=name] button").click();
  await expect(page.locator("[role=columnheader][data-column=name]")).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await search.fill("");
  await expect(page.locator("#sort-status")).toHaveText("");
  expect(messages.filter((text) => /^\[[A-Z_]+\]/.test(text) && !KNOWN.test(text))).toEqual([]);
  expect(errors).toEqual([]);
});
