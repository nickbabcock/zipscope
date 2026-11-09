// The static front door: its sample numbers, its structure, its head tags and
// its literal token values. The page states
// these numbers in the served HTML, so they must agree with the generator.
// `door.css` copies the token values, because it styles the page before any
// script runs.
import { expect, test } from "vitest";
import { formatSize } from "../format";
// oxlint-disable-next-line import/default -- Vite makes this default export.
import tokens from "../theme/tokens.stylex.ts?raw";
import css from "./door.css?raw";
import { crawlFiles, doorHtml, headTags, SHOTS } from "./door-static";
import { SAMPLE_DUPLICATE, SAMPLE_NAME, SAMPLE_TRAILER_BYTES, sampleEntries } from "./sample";
import { remuxFileName } from "../remux/text";
import { door } from "./strings";

/** The pictures of the door. */
const pictures = Object.keys(import.meta.glob("../../public/door/*.avif")).map((path) =>
  path.slice("../../public/door/".length),
);

test("each sample value of the page comes from the generator", () => {
  const entries = sampleEntries();
  expect(door.save.from).toBe(SAMPLE_NAME);
  expect(door.save.to).toBe(remuxFileName(SAMPLE_NAME));
  expect(entries.filter((entry) => entry.name === SAMPLE_DUPLICATE)).toHaveLength(2);
  expect(door.health.sample).toContain(`${formatSize(SAMPLE_TRAILER_BYTES)} of data`);
});

test("the home page has one visible h1, the bands as h2, and the questions as h3", () => {
  const html = doorHtml();
  const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((match) => Number(match[1]));
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  for (const band of [door.fast, door.local, door.preview, door.health, door.save]) {
    expect(html).toContain(`>${band.heading}</h2>`);
  }
  for (const pair of [door.device, door.files, door.reads, door.inside, door.keyboard]) {
    expect(html).toContain(`<h3>${pair.question}</h3>`);
  }
  expect(html).toContain(`<span id="door-wordmark">${door.mark}</span>`);
  expect(html).toContain(door.tagline);
});

test("each picture of the page is in public/door, in both themes", () => {
  expect(pictures.sort()).toEqual(
    Object.keys(SHOTS)
      .flatMap((name) => [`${name}-dark.avif`, `${name}-light.avif`])
      .sort(),
  );
});

test("no origin gives a noindex tag and no tag that needs the origin", () => {
  const tags = headTags(undefined);
  expect(tags).toContainEqual({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
  expect(tags.some((tag) => tag.attrs?.rel === "canonical")).toBe(false);
  expect(tags.some((tag) => tag.attrs?.property === "og:url")).toBe(false);
  expect(tags.some((tag) => tag.tag === "script")).toBe(false);
  expect(headTags("")).toEqual(tags);
});

test("the origin gives the canonical URL and the data block", () => {
  const home = headTags("https://zip.nickb.dev/");
  expect(home).toContainEqual({
    tag: "link",
    attrs: { rel: "canonical", href: "https://zip.nickb.dev/" },
  });
  expect(home).toContainEqual({
    tag: "meta",
    attrs: { property: "og:image", content: "https://zip.nickb.dev/og.png" },
  });
  const data = home.find((tag) => tag.tag === "script")!;
  expect(data.attrs).toEqual({ type: "application/ld+json" });
  expect(JSON.parse(data.children!)).toMatchObject({ "@type": "WebApplication", name: "Zipscope" });
  expect(home.some((tag) => tag.attrs?.name === "robots")).toBe(false);
});

test("the sitemap lists the page, and robots.txt points to it", () => {
  const { sitemap, robots } = crawlFiles("https://zip.nickb.dev/");
  expect(sitemap.match(/<loc>/g)).toHaveLength(1);
  expect(sitemap).toContain("<loc>https://zip.nickb.dev/</loc>");
  expect(robots).toContain("Sitemap: https://zip.nickb.dev/sitemap.xml");
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
