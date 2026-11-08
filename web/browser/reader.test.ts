import { expect, test } from "vitest";
import { page } from "vitest/browser";

test("reader strategies handle sparse zip64 offsets and EOF", async () => {
  // A worker can read only a real file, so the test uploads the file from
  // the corpus.
  const input = document.createElement("input");
  input.type = "file";
  document.body.append(input);
  const worker = new Worker(new URL("./reader-worker.ts", import.meta.url), { type: "module" });
  try {
    // The path is relative to the web directory.
    await page.elementLocator(input).upload("../target/corpus/generated/zip64-sparse.zip");
    const result = await new Promise((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessage = ({ data }) => resolve(data);
      worker.postMessage(input.files![0]);
    });
    expect(result).toEqual({ ok: true });
  } finally {
    worker.terminate();
    input.remove();
  }
});
