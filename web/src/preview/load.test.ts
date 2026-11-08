import { describe, expect, test } from "vitest";
import type { EntryCheck, ReadChunk } from "../contracts";
import { crcFailed, EntryLoader, FIRST_BYTES, HEX_STEP, IMAGE_LIMIT } from "./load";
import { hexDump } from "./sniff";
import type { PreviewView } from "./load";

const OK: EntryCheck = { mismatches: 0, localName: "" };

/** A read worker for one entry of `data`. */
function fakeRead(data: Uint8Array, options: { check?: EntryCheck; failAt?: number } = {}) {
  const calls: [number, number][] = [];
  const read = async (row: number, offset: number, bytes: number): Promise<ReadChunk> => {
    calls.push([offset, bytes]);
    const check = options.check ?? OK;
    if (check.error !== undefined) {
      return { row, bytes: new Uint8Array(0), offset, state: "failed", error: check.error, check };
    }
    const end = Math.min(data.length, offset + bytes, options.failAt ?? Infinity);
    const chunk = data.slice(offset, end);
    if (options.failAt !== undefined && end >= options.failAt) {
      return { row, bytes: chunk, offset, state: "failed", error: "CRC-32 differs", check };
    }
    return {
      row,
      bytes: chunk,
      offset,
      state: end === data.length ? "verified" : "reading",
      check,
    };
  };
  return { read, calls };
}

function loader(read: (row: number, offset: number, bytes: number) => Promise<ReadChunk>) {
  const views: PreviewView[] = [];
  const urls: Blob[] = [];
  const revoked: string[] = [];
  const target = new EntryLoader({
    read,
    createUrl: (blob) => {
      urls.push(blob);
      return `blob:${urls.length}`;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  /** Loads a row and waits for its first view. Returns the load. */
  const load = async (row: number, name: string, declared: number) => {
    const loading = target.load(row, name, declared, (view) => views.push(view));
    await loading.done;
    return loading;
  };
  return { target, load, last: () => views.at(-1)!, views, urls, revoked };
}

type Ready = Extract<PreviewView, { status: "ready" }>;

/** Returns a view that shows its entry. */
function ready(view: PreviewView): Ready {
  expect(view.status).toBe("ready");
  return view as Ready;
}
const textOf = (view: PreviewView) =>
  view.status === "ready" && view.kind === "text" ? view.text : undefined;
const hexOf = (view: PreviewView) =>
  view.status === "ready" && view.kind === "hex" ? hexDump(view.bytes) : undefined;
const imageOf = (view: PreviewView) =>
  view.status === "ready" && view.kind === "image" ? view.image : undefined;

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("EntryLoader", () => {
  test("takes the kind only from a chunk with bytes", async () => {
    // The first reads give no bytes while the entry has more.
    const data = new Uint8Array([0, 1, 2, 3]);
    const { read } = fakeRead(data);
    let empty = 2;
    const slow = (row: number, offset: number, bytes: number): Promise<ReadChunk> =>
      empty-- > 0
        ? Promise.resolve({ row, bytes: new Uint8Array(0), offset, state: "reading", check: OK })
        : read(row, offset, bytes);
    const { load, last } = loader(slow);
    await load(0, "blob.bin", data.length);
    expect(ready(last()).kind).toBe("hex");
  });

  test("stops with an error when the reads give no bytes", async () => {
    const never = (row: number, offset: number): Promise<ReadChunk> =>
      Promise.resolve({ row, bytes: new Uint8Array(0), offset, state: "reading", check: OK });
    const { load, last } = loader(never);
    await load(0, "blob.bin", 4);
    expect(last().status).toBe("error");
    expect("kind" in last()).toBe(false);
  });

  test("shows UTF-8 text and loads more", async () => {
    const data = utf8("é line\n".repeat(300_000)); // About 2.4 MiB.
    const { read, calls } = fakeRead(data);
    const { load, last } = loader(read);
    const target = await load(0, "notes.txt", data.length);
    expect(ready(last()).kind).toBe("text");
    expect(textOf(last())?.encoding).toBe("utf-8");
    expect(ready(last()).loaded).toBe(FIRST_BYTES);
    expect(ready(last()).more).toBe(true);
    // Only the first chunk is read.
    expect(calls).toEqual([[0, FIRST_BYTES]]);
    await target.more();
    await target.more();
    expect(ready(last()).state).toBe("verified");
    expect(ready(last()).more).toBe(false);
    expect(textOf(last())?.text).toBe("é line\n".repeat(300_000));
  });

  test("falls back to Windows-1252 with its encoding", async () => {
    const data = Uint8Array.from("Le café, très bon", (char) => char.charCodeAt(0));
    const { load, last } = loader(fakeRead(data).read);
    await load(0, "fr.txt", data.length);
    expect(textOf(last())).toEqual({ text: "Le café, très bon", encoding: "windows-1252" });
  });

  test("shows HTML as text, never as markup", async () => {
    const html = utf8("<!doctype html><script>alert(1)</script>");
    const { load, last } = loader(fakeRead(html).read);
    await load(0, "index.html", html.length);
    expect(ready(last()).kind).toBe("text");
    expect(imageOf(last())).toBeUndefined();
  });

  test("shows binary data as hex in steps", async () => {
    const data = Uint8Array.from({ length: 200_000 }, (_, i) => i % 256);
    const { load, last } = loader(fakeRead(data).read);
    const target = await load(0, "data.bin", data.length);
    expect(ready(last()).kind).toBe("hex");
    expect(ready(last()).shown).toBe(HEX_STEP);
    expect(hexOf(last())?.split("\n")).toHaveLength(HEX_STEP / 16);
    await target.more();
    expect(ready(last()).shown).toBe(2 * HEX_STEP);
  });

  test("shows an image from a Blob URL after it is verified", async () => {
    const png = new Uint8Array(5 * 1024 * 1024);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { read, calls } = fakeRead(png);
    const { load, last, urls } = loader(read);
    await load(0, "photo.png", png.length);
    expect(ready(last()).kind).toBe("image");
    expect(imageOf(last())).toBe("blob:1");
    expect(urls[0]?.type).toBe("image/png");
    expect(urls[0]?.size).toBe(png.length);
    expect(calls.length).toBeGreaterThan(1);
  });

  test("shows SVG only as an image", async () => {
    const svg = utf8('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    const { load, last, urls } = loader(fakeRead(svg).read);
    await load(0, "icon.svg", svg.length);
    expect(ready(last()).kind).toBe("image");
    expect(urls[0]?.type).toBe("image/svg+xml");
  });

  test("shows a large or broken image as hex", async () => {
    const png = new Uint8Array(4096);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const large = loader(fakeRead(png).read);
    await large.load(0, "huge.png", IMAGE_LIMIT + 1);
    expect(ready(large.last()).kind).toBe("hex");
    expect(ready(large.last()).note).toContain("larger than 32\u00a0MiB");

    const broken = loader(fakeRead(png, { failAt: 2048 }).read);
    await broken.load(0, "bad.png", png.length);
    expect(ready(broken.last()).kind).toBe("hex");
    expect(ready(broken.last()).error).toBe("CRC-32 differs");
    expect(broken.urls).toHaveLength(0);
  });

  test("shows the data of a CRC-32 failure and reports the row", async () => {
    const error = "The CRC-32 of the data is 1A2B3C4D, but the central directory gives DEADBEEF";
    const data = utf8("this crc lies ".repeat(100));
    const failed: number[] = [];
    const target = new EntryLoader({
      read: async (row, offset) => ({
        row,
        bytes: data.slice(offset),
        offset,
        state: "failed",
        error,
        check: OK,
      }),
      createUrl: () => "",
      revokeUrl: () => {},
      onCrcFailure: (row) => failed.push(row),
    });
    const views: PreviewView[] = [];
    await target.load(7, "bad-crc.txt", data.length, (view) => views.push(view)).done;
    const shown = ready(views.at(-1)!);
    expect(textOf(shown)?.text).toBe("this crc lies ".repeat(100));
    expect(shown.state).toBe("failed");
    expect(shown.error).toBe(error);
    expect(shown.shown).toBe(data.length);
    expect(failed).toEqual([7]);
    expect(crcFailed(error)).toBe(true);
    expect(crcFailed("The data ended after 3 bytes, but the central directory gives 9 bytes")).toBe(
      false,
    );
  });

  test("shows why an entry cannot be decoded", async () => {
    const check = { mismatches: 0, localName: "", error: "This entry is encrypted" };
    const { load, last } = loader(fakeRead(new Uint8Array(0), { check }).read);
    await load(0, "secret.txt", 10);
    expect(last()).toMatchObject({ status: "error", error: "This entry is encrypted" });
  });

  test("a cancelled load shows nothing when its read ends late", async () => {
    const slow = Promise.withResolvers<ReadChunk>();
    const fast = fakeRead(utf8("fast")).read;
    let first = true;
    const { target, views } = loader((row, offset, bytes) => {
      if (first) {
        first = false;
        return slow.promise;
      }
      return fast(row, offset, bytes);
    });
    const publish = (view: PreviewView) => views.push(view);
    const old = target.load(1, "old.txt", 3, publish);
    // The owner cancels the old load when the target changes.
    old.cancel();
    await target.load(2, "new.txt", 4, publish).done;
    slow.resolve({ row: 1, bytes: utf8("old"), offset: 0, state: "verified", check: OK });
    await old.done;
    expect(views.at(-1)!.row).toBe(2);
    expect(textOf(views.at(-1)!)?.text).toBe("fast");
    expect(views.filter((view) => view.row === 1)).toEqual([{ status: "loading", row: 1 }]);
  });

  test("a cancel revokes the image URL of its own load", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const { target, revoked } = loader(fakeRead(png).read);
    const first = target.load(0, "a.png", png.length, () => {});
    await first.done;
    const second = target.load(0, "a.png", png.length, () => {});
    await second.done;
    expect(revoked).toEqual([]);
    first.cancel();
    expect(revoked).toEqual(["blob:1"]);
    second.cancel();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });

  test("a cancel stops its own load only", async () => {
    const { target, views } = loader(fakeRead(utf8("text")).read);
    const old = target.load(1, "old.txt", 4, (view) => views.push(view));
    const next = target.load(2, "new.txt", 4, (view) => views.push(view));
    // The memo can start the new load before the teardown of the old one
    // runs. Each load has its own state, so this does not stop the new one.
    old.cancel();
    await next.done;
    expect(textOf(views.at(-1)!)?.text).toBe("text");
    expect(views.at(-1)!.row).toBe(2);
    const count = views.length;
    // After a cancel, a load publishes nothing more.
    const last = target.load(3, "last.txt", 4, (view) => views.push(view));
    last.cancel();
    await last.done;
    expect(views).toHaveLength(count + 1);
    expect(views.at(-1)).toEqual({ status: "loading", row: 3 });
  });
});
