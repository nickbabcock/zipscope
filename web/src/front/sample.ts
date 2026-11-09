// The demo archive of "Try a sample archive". The browser generates it on
// the device: no file comes from the network. It looks like the release
// build of a desktop app, with about one thousand entries in nested
// folders. One file is a clear space hog: the unstripped debug symbols.
// The archive also has two mild health findings that the tool detects:
// one name occurs two times, and a few KiB of data follow the end record.
// The same seed always gives the same archive.
import { writeZip } from "./zip";
import type { ZipEntry } from "./zip";

import {
  SAMPLE_DUPLICATE,
  SAMPLE_HOG,
  SAMPLE_NAME,
  SAMPLE_PICTURE,
  SAMPLE_PICTURE_ROW,
  SAMPLE_ROOT as ROOT,
  SAMPLE_TRAILER_BYTES,
} from "./sample-names";

export {
  SAMPLE_DUPLICATE,
  SAMPLE_HOG,
  SAMPLE_NAME,
  SAMPLE_PICTURE,
  SAMPLE_PICTURE_ROW,
  SAMPLE_TRAILER_BYTES,
};

/** The icon of the demo app: three layers on a blue tile. */
const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#tile)"/>
  <g fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">
    <path d="M128 56 204 96 128 136 52 96Z" fill="#fff"/>
    <path d="M52 132 128 172 204 132" stroke-opacity="0.8"/>
    <path d="M52 168 128 208 204 168" stroke-opacity="0.6"/>
  </g>
</svg>
`;

/** A small seeded random number generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "archive build config default demo entry error event file folder index " +
  "layout load module option output panel parse path plugin read release " +
  "render request result schema search session size state store stream " +
  "string table theme tree update value view window worker write cache " +
  "client server token query filter format header label limit offset"
).split(" ");

const LOCALES = (
  "ar bg ca cs da de el en_GB es et fi fr he hi hr hu id it ja ko lt lv nb " +
  "nl pl pt pt_BR ro ru sk sl sr sv th tr uk vi zh_CN zh_TW"
).split(" ");

const CRATES = (
  "anyhow base64 bitflags bytes cfg-if chrono clap crc32fast crossbeam " +
  "either flate2 futures getrandom hashbrown http indexmap itoa libc log " +
  "memchr mime once_cell parking_lot percent-encoding proc-macro2 quote " +
  "rand regex ring rustls ryu serde serde_json smallvec syn thiserror " +
  "tokio toml tracing unicode-ident url uuid walkdir winapi zstd"
).split(" ");

const ICONS = (
  "app archive back bookmark calendar chart check clock close cloud copy " +
  "download edit file filter folder gear help home info link lock menu " +
  "open play refresh save search share star trash upload user"
).split(" ");

/** The parts of a text generator and a binary generator, with one seed. */
class Content {
  private readonly next: () => number;
  private readonly encoder = new TextEncoder();

  constructor(seed: number) {
    this.next = random(seed);
  }

  /** Fills `out` from `start` to `end` with random bytes, four bytes for
   *  each random number. */
  fill(out: Uint8Array, start: number, end: number): void {
    for (let i = start; i < end; i += 4) {
      const value = (this.next() * 4294967296) >>> 0;
      out[i] = value;
      if (i + 1 < end) out[i + 1] = value >>> 8;
      if (i + 2 < end) out[i + 2] = value >>> 16;
      if (i + 3 < end) out[i + 3] = value >>> 24;
    }
  }

  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  word(): string {
    return WORDS[this.int(0, WORDS.length - 1)]!;
  }

  hex(length: number): string {
    let text = "";
    for (let i = 0; i < length; i++) text += this.int(0, 15).toString(16);
    return text;
  }

  /** Text of about `bytes` bytes, made of lines of words. */
  text(bytes: number, prefix = ""): Uint8Array {
    const lines: string[] = [prefix];
    let length = prefix.length;
    while (length < bytes) {
      const words = this.int(4, 12);
      let line = "";
      for (let i = 0; i < words; i++) line += `${this.word()} `;
      line += `${this.int(0, 9999)}`;
      lines.push(line);
      length += line.length + 1;
    }
    return this.encoder.encode(lines.join("\n"));
  }

  /** Bytes that compress a little: random bytes with runs of zeros and
   *  repeated words, as in machine code. */
  binary(bytes: number, noise = 0.6): Uint8Array {
    const out = new Uint8Array(bytes);
    let i = 0;
    while (i < bytes) {
      const run = this.int(16, 256);
      const end = Math.min(bytes, i + run);
      if (this.next() < noise) {
        this.fill(out, i, end);
        i = end;
      } else if (this.next() < 0.5) {
        i = end;
      } else {
        const word = this.encoder.encode(`${this.word()}_${this.word()}::${this.word()}`);
        for (let k = 0; i < end; i++, k++) out[i] = word[k % word.length]!;
      }
    }
    return out;
  }

  /** Bytes that do not compress, as in PNG or WOFF2 files. */
  noise(bytes: number): Uint8Array {
    const out = new Uint8Array(bytes);
    this.fill(out, 0, bytes);
    return out;
  }
}

/** Returns the entries of the demo archive, in archive order. */
export function sampleEntries(seed = 240): ZipEntry[] {
  const c = new Content(seed);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  // A random name that is already in the archive is not added again.
  const add = (name: string, data: Uint8Array, executable = false) => {
    if (!names.has(name)) {
      names.add(name);
      // PNG and WOFF2 files are compressed already.
      const store = /\.(png|woff2)$/.test(name);
      entries.push({ name: `${ROOT}/${name}`, data, executable, store });
    }
  };
  const KiB = 1024;

  add("bin/demo-app", c.binary(900 * KiB), true);
  add("bin/demo-app-helper", c.binary(180 * KiB), true);
  for (const lib of ["core", "render", "net", "store", "plugin", "search", "media", "sync"]) {
    add(`lib/libdemo_${lib}.so.2.4.0`, c.binary(c.int(40, 160) * KiB));
  }
  add("debug/demo-app.debug", c.binary(12 * 1024 * KiB, 0.4));
  add("debug/demo-app-helper.debug", c.binary(240 * KiB, 0.45));
  // A real picture, so the preview of the sample can show one. The name has
  // no random part, so the row stays SAMPLE_PICTURE_ROW.
  add(SAMPLE_PICTURE.slice(ROOT.length + 1), new TextEncoder().encode(APP_ICON));

  for (const name of ["app", "logging", "network", "plugins", "search", "storage", "theme"]) {
    add(`config/defaults/${name}.toml`, c.text(c.int(1, 6) * KiB, `# ${name} defaults\n`));
  }
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    for (const icon of ICONS) {
      const bytes = Math.max(200, Math.round((size * size) / 6) + c.int(0, 400));
      add(`share/demo-app/icons/hicolor/${size}x${size}/actions/${icon}.png`, c.noise(bytes));
    }
  }
  for (const locale of LOCALES) {
    add(`share/locale/${locale}/LC_MESSAGES/demo-app.mo`, c.text(c.int(6, 18) * KiB));
  }
  for (let i = 0; i < 140; i++) {
    const kind = c.word();
    add(`share/demo-app/web/static/js/${kind}-${c.hex(8)}.js`, c.text(c.int(2, 24) * KiB));
  }
  for (let i = 0; i < 18; i++) {
    add(`share/demo-app/web/static/css/${c.word()}-${c.hex(8)}.css`, c.text(c.int(1, 20) * KiB));
  }
  for (const weight of ["regular", "italic", "medium", "semibold", "bold", "mono"]) {
    add(`share/demo-app/web/static/fonts/inter-${weight}.woff2`, c.noise(c.int(20, 60) * KiB));
  }
  add("share/demo-app/web/index.html", c.text(3 * KiB, "<!doctype html>\n"));
  for (let i = 1; i <= 64; i++) {
    const number = String(i).padStart(4, "0");
    add(
      `share/demo-app/migrations/${number}_${c.word()}_${c.word()}.sql`,
      c.text(c.int(1, 8) * KiB),
    );
  }
  for (let i = 0; i < 36; i++) {
    add(`share/demo-app/schemas/${c.word()}-${c.word()}.schema.json`, c.text(c.int(1, 12) * KiB));
  }
  for (const doc of ["README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "SECURITY.md"]) {
    add(`share/doc/demo-app/${doc}`, c.text(c.int(2, 30) * KiB, `${doc}\n`));
  }
  // Each crate has one license file per version. Two versions of some
  // crates are in the build.
  for (const crate of CRATES) {
    const versions = c.int(1, 3);
    for (let v = 0; v < versions; v++) {
      const version = `${c.int(0, 4)}.${c.int(0, 30)}.${c.int(0, 12)}`;
      for (const file of ["LICENSE-MIT", "LICENSE-APACHE", "README.md", "Cargo.toml"]) {
        add(`share/licenses/third-party/${crate}-${version}/${file}`, c.text(c.int(1, 5) * KiB));
      }
    }
  }
  // The packaging step added the changelog a second time.
  const changelog = entries.find((entry) => entry.name === SAMPLE_DUPLICATE)!;
  entries.push({ ...changelog });
  return entries;
}

/** The bytes after the end record: a build stamp that a packaging tool
 *  appended. */
function trailer(): Uint8Array {
  const c = new Content(7);
  const line = "demo-app 2.4.0 release build stamp\n";
  let text = line;
  while (text.length < SAMPLE_TRAILER_BYTES) text += `${c.hex(64)}\n`;
  return new TextEncoder().encode(text.slice(0, SAMPLE_TRAILER_BYTES));
}

/** Generates the demo archive as a File. */
export async function buildSample(): Promise<File> {
  const blob = await writeZip(sampleEntries(), {
    time: new Date(Date.UTC(2026, 8, 14, 10, 32, 0)),
    trailer: trailer(),
  });
  return new File([blob], SAMPLE_NAME, { type: "application/zip" });
}
