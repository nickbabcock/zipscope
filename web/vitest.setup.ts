// Setup of the unit tests. The wasm-bindgen modules fetch their .wasm file
// from a file: URL, and the fetch of Node cannot read file: URLs. This fetch
// reads them from the disk.
import { readFile } from "node:fs/promises";

// The config sets the locale of the test process (`LC_ALL`). Stop here when
// the platform does not use it, because then the number text is different.
const locale = new Intl.NumberFormat().resolvedOptions().locale;
if (locale !== "en-US") {
  throw new Error(`The unit tests need the en-US locale, but the locale is ${locale}`);
}

const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (input instanceof URL && input.protocol === "file:") {
    return new Response(await readFile(input), {
      headers: { "Content-Type": "application/wasm" },
    });
  }
  return nodeFetch(input, init);
};
