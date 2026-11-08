// The static front door: its sample numbers and its literal token values. The
// page states these numbers in the served HTML, so they must agree with the
// generator. `door.css` copies the token values, because it styles the page
// before any script runs.
import { expect, test } from "vitest";
import { formatSize } from "../format";
// oxlint-disable-next-line import/default -- Vite makes this default export.
import tokens from "../theme/tokens.stylex.ts?raw";
import css from "./door.css?raw";
import { BAR_SLOT } from "../grid/columns";
import { hasBar } from "../view/model";
import { doorHtml, originTags } from "./door-static";
import {
  SAMPLE_DUPLICATE,
  SAMPLE_HOG,
  SAMPLE_NAME,
  SAMPLE_TRAILER_BYTES,
  sampleEntries,
} from "./sample";
import { SAMPLE_ROOT } from "./sample-names";
import { door } from "./strings";

test("each sample number in the answers comes from the generator", () => {
  const entries = sampleEntries();
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const hog = entries.find((entry) => entry.name === SAMPLE_HOG)!;
  const folders = new Set(entries.map((entry) => entry.name.split("/")[1]!));

  expect(door.contents.answer).toContain(`**${entries.length} entries** in five folders`);
  expect(folders.size).toBe(5);
  for (const folder of folders) expect(door.contents.answer).toContain(`\`${folder}\``);
  expect(door.demoLabel).toContain(`\`${SAMPLE_NAME}\``);

  const path = SAMPLE_HOG.slice(SAMPLE_ROOT.length + 1);
  const share = `${Math.round((hog.data.length / total) * 100)}%`;
  expect(door.space.answer).toBe(
    `\`${path}\` is **${formatSize(hog.data.length)}** of the ${formatSize(total)}.`,
  );
  expect(door.space.share).toBe(share);
  expect(door.space.shareName.startsWith(share)).toBe(true);
  // The bar draws the same share.
  expect(/#door-bar-fill \{[^}]*\bwidth: (\d+%);/.exec(css)?.[1]).toBe(share);

  expect(entries.filter((entry) => entry.name === SAMPLE_DUPLICATE)).toHaveLength(2);
  expect(door.health.answer).toContain(`**${formatSize(SAMPLE_TRAILER_BYTES)}** of data`);
});

test("each row of the first view comes from the generator", () => {
  const entries = sampleEntries();
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const folders = new Map<string, number>();
  for (const entry of entries) {
    const folder = `${entry.name.split("/")[1]!}/`;
    folders.set(folder, (folders.get(folder) ?? 0) + entry.data.length);
  }
  const largest = [...folders].sort((a, b) => b[1] - a[1]);
  door.space.rows.forEach((row, index) => {
    const [name, bytes] = largest[index]!;
    expect(row.name).toBe(name);
    expect(row.size).toBe(formatSize(bytes));
    expect(row.share).toBe(Math.round((bytes / total) * 100));
    // The bar shows only when the tool also draws a bar for this row.
    expect(doorHtml().includes(`<rect width="${(row.share / 100) * BAR_SLOT}"`)).toBe(
      hasBar(bytes, total, BAR_SLOT),
    );
  });
});

test("the served HTML has the hidden h1 first and each question as an h2", () => {
  const html = doorHtml();
  expect(html.startsWith(`<h1 id="door-h1">${door.heading}</h1>`)).toBe(true);
  const headings = [...html.matchAll(/<h([1-6])[ >]/g)].map((match) => Number(match[1]));
  expect(headings[0]).toBe(1);
  expect(headings.slice(1).every((level) => level === 2)).toBe(true);
  for (const question of [
    door.contents.question,
    door.space.question,
    door.health.question,
    door.files.question,
    door.reads.question,
    door.lies.question,
    door.inside.question,
    door.device.question,
    door.keyboard.question,
    ...door.formats.map((format) => format.question),
    door.close,
  ]) {
    expect(html).toContain(`<h2>${question}</h2>`);
  }
});

test("the origin gives three head tags, and no origin gives none", () => {
  expect(originTags(undefined)).toEqual([]);
  expect(originTags("")).toEqual([]);
  expect(originTags("https://zip.nickb.dev/")).toEqual([
    { tag: "link", attrs: { rel: "canonical", href: "https://zip.nickb.dev/" } },
    { tag: "meta", attrs: { property: "og:url", content: "https://zip.nickb.dev/" } },
    { tag: "meta", attrs: { property: "og:image", content: "https://zip.nickb.dev/og.png" } },
  ]);
});

/** Reads a token of `tokens.stylex.ts`: its light and night values. */
function tokenColor(name: string): { light: string; night: string } {
  const match = new RegExp(`\\b${name}: \\{ default: "([^"]+)", \\[NIGHT\\]: "([^"]+)" \\}`).exec(
    tokens,
  );
  if (match === null) throw new Error(`No token ${name}`);
  return { light: match[1]!, night: match[2]! };
}

function tokenValue(name: string): string {
  const match = new RegExp(`\\b${name}: ['"](.+)['"],`).exec(tokens);
  if (match === null) throw new Error(`No token ${name}`);
  return match[1]!;
}

test("door.css has the literal values of the tokens", () => {
  const nightStart = css.indexOf("@media (prefers-color-scheme: dark)");
  const narrowStart = css.indexOf("@media (max-width: 640px)");
  const light = css.slice(0, nightStart);
  const night = css.slice(nightStart, narrowStart);
  const value = (block: string, name: string) => {
    const match = new RegExp(`--door-${name}: ([^;]+);`).exec(block);
    if (match === null) throw new Error(`No value ${name}`);
    return match[1]!;
  };
  for (const [name, token] of [
    ["ground", "ground"],
    ["panel", "panel"],
    ["raised", "raised"],
    ["rule", "rule"],
    ["rule-strong", "ruleStrong"],
    ["ink", "ink"],
    ["ink-muted", "inkMuted"],
    ["water", "water"],
    ["focus", "focus"],
    ["warn", "warn"],
    ["bar", "bar"],
    ["bar-track", "barTrack"],
  ] as const) {
    const expected = tokenColor(token);
    expect(value(light, name), name).toBe(expected.light);
    expect(value(night, name), name).toBe(expected.night);
  }
  for (const [name, token] of [
    ["ui", "ui"],
    ["mono", "mono"],
    ["top", "top"],
    ["status", "status"],
    ["statement", "statement"],
    ["heading", "heading"],
    ["subtitle", "subtitle"],
    ["reading", "reading"],
    ["lead", "lead"],
    ["title", "title"],
    ["body", "body"],
    ["small", "small"],
    ["label", "label"],
  ] as const) {
    expect(value(light, name), name).toBe(tokenValue(token));
  }
});
