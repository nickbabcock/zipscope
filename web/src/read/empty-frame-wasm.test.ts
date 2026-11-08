// An empty Zstandard frame before a frame with a larger window.
// The first wasm call goes past the empty frame and
// stops before the larger window, with no bytes. The worker calls again,
// so a read, a read at an offset (a skip) and the preview kind are right.
// Its own file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { EntryLoader } from "../preview/load";
import type { PreviewView } from "../preview/load";
import { concat, header, openWorker, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A frame with one raw block of `body` and a window of `2^log`. */
function rawFrame(log: number, body: Uint8Array): Uint8Array {
  const value = (body.length << 3) | 1;
  return concat(
    new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, (log - 10) << 3]),
    new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255]),
    body,
  );
}

/** Opens an entry of `body` behind an empty frame. */
async function entry(name: string, body: Uint8Array) {
  const data = concat(rawFrame(20, new Uint8Array(0)), rawFrame(23, body));
  const { bytes, page } = zip([{ name, body, data, method: 93 }]);
  return openWorker(mocks.expose, bytes, header(State.COMPLETE, 1), page);
}

/** Loads the preview of row 0. */
async function preview(api: Awaited<ReturnType<typeof entry>>, name: string, size: number) {
  let shown: PreviewView | undefined;
  const loader = new EntryLoader({
    read: (row, offset, bytes) => api.read(row, offset, bytes),
    createUrl: () => "blob:image",
    revokeUrl: () => {},
  });
  await loader.load(0, name, size, (view) => {
    shown = view;
  }).done;
  return shown!;
}

test("a read goes past an empty frame", async () => {
  const body = new Uint8Array([0, 1, 2, 3]);
  const api = await entry("binary.bin", body);
  const chunk = await api.read(0, 0, 1024);
  expect([...chunk.bytes]).toEqual([0, 1, 2, 3]);
  expect(chunk.state).toBe("verified");
});

test("a read at an offset skips past an empty frame", async () => {
  const body = new Uint8Array([0, 1, 2, 3]);
  const api = await entry("binary.bin", body);
  const chunk = await api.read(0, 1, 2);
  expect(chunk.offset).toBe(1);
  expect([...chunk.bytes]).toEqual([1, 2]);
});

test("the preview kind comes from the bytes after an empty frame", async () => {
  const binary = new Uint8Array([0, 1, 2, 3]);
  expect(await preview(await entry("binary.bin", binary), "binary.bin", 4)).toMatchObject({
    status: "ready",
    kind: "hex",
  });
  // A PNG of one pixel.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNuoAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  const image = await preview(await entry("image.png", png), "image.png", png.length);
  expect(image).toMatchObject({ status: "ready", kind: "image", image: "blob:image" });
});
