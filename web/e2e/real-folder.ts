// A real folder that a page can write to, with no picker, in a headless browser. A
// new profile has a stored write grant for one origin and one folder, and CDP drops
// this folder on the page.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

/** Writes a new profile whose origin can write to `folder`. The next drop of this
 *  folder then gets a handle that can write, with no prompt. The keys are those of
 *  Chromium 156. A later version can change them, and then `dropFolder` throws. */
export function grantFolder(profile: string, folder: string, origin: string): void {
  const pattern = `${origin},*`;
  const stamp = "13400000000000000";
  const chosen = {
    path: folder,
    "is-directory": true,
    readable: true,
    writable: true,
    "display-name": path.basename(folder),
  };
  const exceptions = {
    file_system_access_chooser_data: {
      [pattern]: { last_modified: stamp, setting: { "chosen-objects": [chosen] } },
    },
    file_system_access_extended_permission: { [pattern]: { last_modified: stamp, setting: 1 } },
  };
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ profile: { content_settings: { exceptions } } }),
  );
}

/** Drops a real folder on the page, and keeps its handle for the picker stub. */
export async function dropFolder(
  context: BrowserContext,
  page: Page,
  folder: string,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => {
    const scope = window as unknown as {
      __dropped?: Promise<FileSystemHandle>;
      __endDrop?: () => void;
    };
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const drop = (event: DragEvent) => {
      stop(event);
      const item = event.dataTransfer!.items[0] as DataTransferItem & {
        getAsFileSystemHandle(): Promise<FileSystemHandle>;
      };
      scope.__dropped = item.getAsFileSystemHandle();
    };
    window.addEventListener("dragenter", stop, true);
    window.addEventListener("dragover", stop, true);
    window.addEventListener("drop", drop, true);
    scope.__endDrop = () => {
      window.removeEventListener("dragenter", stop, true);
      window.removeEventListener("dragover", stop, true);
      window.removeEventListener("drop", drop, true);
    };
  });
  const data = { items: [], files: [folder], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x: 50, y: 50, data });
  }
  await cdp.detach();
  const state = await page.evaluate(async () => {
    const scope = window as unknown as {
      __dropped: Promise<FileSystemHandle & { queryPermission(mode: object): Promise<string> }>;
      __endDrop: () => void;
      __realFolder?: FileSystemHandle;
    };
    const handle = await scope.__dropped;
    scope.__realFolder = handle;
    scope.__endDrop();
    return `${handle.kind} ${await handle.queryPermission({ mode: "readwrite" })}`;
  });
  if (state !== "directory granted") throw new Error(`No real folder with write: ${state}`);
}
