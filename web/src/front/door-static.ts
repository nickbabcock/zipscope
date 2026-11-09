// The served HTML of the front door. The build puts it in `index.html` (see
// `vite.config.ts`), so a reader or a search engine
// has the whole page before any script runs, and `door.css` styles it. When
// the app starts, it moves these elements into the door. This module must not
// use the DOM: the Vite config imports it in Node.
import { door } from "./strings.ts";

/** The ids that the app needs. Tests and `door.css` use the same ids. */
export const DOOR_IDS = {
  heading: "door-h1",
  frame: "door-frame",
  page: "door-page",
} as const;

/** The pictures of the tool on the sample archive, in `public/door/`.
 *  `scripts/door-shots.ts` makes them. The sizes are CSS pixels: each file
 *  has two times as many. */
export const SHOTS = {
  tool: { width: 1312, height: 760 },
  mobile: { width: 390, height: 430 },
  /** The preview of the picture of the sample, for the preview band. */
  preview: { width: 800, height: 540 },
} as const;

/** The production origin, with no slash at the end. */
export const ORIGIN = "https://zip.nickb.dev";

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes copy. A word in backticks goes in a `<code>` element, and a number
 *  in double stars goes in a `<b>` element. */
function copy(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/** A Lucide icon, as the tool draws it. */
function icon(name: "warn" | "down", size: number): string {
  const paths = {
    warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  };
  return `<svg class="door-icon door-icon-${name}" aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

/** A picture of the tool, in the light or the night theme of the visitor.
 *  `mobile` gives a second picture for narrow windows. */
function picture(
  name: "tool" | "preview",
  alt: string,
  mobile?: "mobile",
  loading: "eager" | "lazy" = "lazy",
): string {
  const size = SHOTS[name];
  const narrow = "(max-width: 640px)";
  const source = (file: string, media: string, box: { width: number; height: number }) =>
    `<source srcset="/door/${file}.avif" type="image/avif" media="${media}" width="${box.width}" height="${box.height}">`;
  return [
    "<picture>",
    mobile === undefined
      ? ""
      : source(`${mobile}-dark`, `${narrow} and (prefers-color-scheme: dark)`, SHOTS[mobile]) +
        source(`${mobile}-light`, narrow, SHOTS[mobile]),
    source(`${name}-dark`, "(prefers-color-scheme: dark)", size),
    `<img src="/door/${name}-light.avif" width="${size.width}" height="${size.height}" alt="${escape(alt)}" loading="${loading}" decoding="async">`,
    "</picture>",
  ].join("");
}

/** The row of actions: the buttons, then the line about a drop. */
function actionRow(): string {
  const { action, noScript } = door;
  return [
    `<div id="door-row">`,
    `<div id="door-buttons"></div>`,
    `<p id="door-action">`,
    `<span class="door-line" data-line="fine">${escape(action.fine)}</span>`,
    `<span class="door-line" data-line="coarse">${escape(action.coarse)}</span>`,
    `<span class="door-line" data-line="dragging">${escape(action.dragging)}</span>`,
    `</p>`,
    `<noscript><p id="door-noscript">${escape(noScript)}</p></noscript>`,
    `<p id="door-failed" hidden>${escape(noScript)}</p>`,
    `</div>`,
  ].join("");
}

/** The visible `h1`: a word mark at poster scale, then what the page is. */
function heading(): string {
  return [
    `<h1 id="${DOOR_IDS.heading}">`,
    `<span id="door-wordmark">${escape(door.mark)}</span>`,
    `<span class="door-hidden">: </span>`,
    `<span id="door-h1-tagline">${escape(door.tagline)}</span>`,
    `</h1>`,
  ].join("");
}

/** The first view: the lead, the actions, the picture of the tool and the
 *  file types that Zipscope opens. */
function hero(): string {
  return [
    `<section id="door-hero" aria-labelledby="${DOOR_IDS.heading}">`,
    `<p id="door-lead">${copy(door.lead)}</p>`,
    actionRow(),
    // The recent archives (Chromium): directly below the actions, so a
    // returning visitor sees them in the first view. The app draws them.
    `<div id="door-recent"></div>`,
    // The picture is the way into the sample, so its caption comes first: it
    // is in the first view, and the bottom of the picture is not.
    `<figure id="door-shot-frame">`,
    `<figcaption id="door-shot-label"><span class="door-tag">Demo</span> ${copy(door.shotLabel)}</figcaption>`,
    `<div id="door-shot">${picture("tool", door.shotAlt, "mobile", "eager")}</div>`,
    `</figure>`,
    `<p id="door-opens">${escape(door.opens)}</p>`,
    `</section>`,
  ].join("");
}

/** One band of the five: a datum on the left, the claim on the right. */
function band(id: string, datum: string, title: string, body: string, after = ""): string {
  return [
    `<section class="door-band" id="door-${id}" aria-labelledby="door-${id}-h">`,
    `<div class="door-datum">${datum}</div>`,
    `<div class="door-claim"><h2 id="door-${id}-h">${escape(title)}</h2><p>${body}</p>${after}</div>`,
    `</section>`,
  ].join("");
}

function bands(): string {
  const { fast, local, preview, health, save } = door;
  const figure = (value: string, unit: string) =>
    `<p class="door-figure">${escape(value)}</p><p class="door-unit">${escape(unit)}</p>`;
  return [
    `<div id="door-bands">`,
    band(
      "fast",
      figure(fast.figure, fast.unit),
      fast.heading,
      copy(fast.body),
      `<p class="door-note">${escape(fast.note)}</p>`,
    ),
    band(
      "local",
      figure(local.figure, local.unit),
      local.heading,
      copy(local.body),
      `<p class="door-note">${escape(local.note)}</p><p id="front-test"></p>`,
    ),
    band(
      "preview",
      `<div class="door-preview-shot">${picture("preview", preview.shotAlt)}</div>`,
      preview.heading,
      copy(preview.body),
    ),
    band(
      "health",
      `<p class="door-figure door-warn">${icon("warn", 48)}<span>${health.counts
        .split(", ")
        .map((part) => `<span>${escape(part)}</span>`)
        .join('<span class="door-hidden">, </span>')}</span></p>`,
      health.heading,
      copy(health.body),
      `<p class="door-sample">${copy(health.sample)}</p>`,
    ),
    band(
      "save",
      `${figure(save.figure, save.unit)}<p class="door-files"><code>${escape(save.from)}</code>${icon("down", 16)}<code>${escape(save.to)}</code></p>`,
      save.heading,
      copy(save.body),
      `<p class="door-note">${escape(save.note)}</p>`,
    ),
    `</div>`,
  ].join("");
}

/** The close of the page, and its footer. */
function close(): string {
  return [
    `<section id="door-close" aria-labelledby="door-close-h">`,
    `<h2 id="door-close-h">${escape(door.close)}</h2>`,
    `<div id="door-close-buttons"></div>`,
    `</section>`,
    `<div id="door-foot">`,
    `<p>${escape(door.footer)}</p>`,
    `</div>`,
  ].join("");
}

/** The title of the home page. */
export const HOME_TITLE = "Zip viewer in your browser: no upload, huge archives | Zipscope";
/** The meta description of the home page. */
export const HOME_DESCRIPTION =
  "See what is in a zip, jar, apk, whl, vsix or docx file and where the space went. A 100 GB file or a million entries shows its first rows in about 0.1 s, in your browser. No upload.";

/** Returns the head tags of the page. With no origin, the build is a preview
 *  or a local build, so the page gets a tag that keeps search engines from
 *  indexing it, and no tag that needs the origin. */
export function headTags(
  origin: string | undefined,
): { tag: string; attrs?: Record<string, string>; children?: string }[] {
  const title = HOME_TITLE;
  const description = HOME_DESCRIPTION;
  const tags: { tag: string; attrs?: Record<string, string>; children?: string }[] = [
    { tag: "title", children: title },
    { tag: "meta", attrs: { name: "description", content: description } },
    { tag: "meta", attrs: { property: "og:type", content: "website" } },
    { tag: "meta", attrs: { property: "og:site_name", content: "Zipscope" } },
    { tag: "meta", attrs: { property: "og:title", content: title } },
    { tag: "meta", attrs: { property: "og:description", content: description } },
    { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
  ];
  const base = origin?.replace(/\/+$/, "");
  if (base === undefined || base === "") {
    return [...tags, { tag: "meta", attrs: { name: "robots", content: "noindex" } }];
  }
  const url = `${base}/`;
  tags.push(
    { tag: "link", attrs: { rel: "canonical", href: url } },
    { tag: "meta", attrs: { property: "og:url", content: url } },
    { tag: "meta", attrs: { property: "og:image", content: `${base}/og.png` } },
  );
  // A data block: the browser does not run it, so the CSP does not apply.
  const app = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Zipscope",
    url,
    description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    browserRequirements: "Chrome 125, Firefox 147, Safari 26 or a later version",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    license: "https://opensource.org/license/mit",
  };
  tags.push({
    tag: "script",
    attrs: { type: "application/ld+json" },
    children: JSON.stringify(app).replace(/</g, "\\u003c"),
  });
  return tags;
}

/** Returns `sitemap.xml` and `robots.txt` for the origin. */
export function crawlFiles(origin: string): { sitemap: string; robots: string } {
  const base = origin.replace(/\/+$/, "");
  return {
    sitemap: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <url><loc>${base}/</loc></url>`,
      "</urlset>",
      "",
    ].join("\n"),
    robots: `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`,
  };
}

/** Returns the HTML in the place of the root element: the root element, and
 *  then the frame of the static page. */
export function doorHtml(): string {
  return [
    `<div id="root"></div>`,
    `<div id="${DOOR_IDS.frame}">`,
    `<main id="door-work">`,
    heading(),
    `<div id="${DOOR_IDS.page}">`,
    hero(),
    bands(),
    close(),
    `</div></main>`,
    `<div id="door-margin"></div>`,
    `</div>`,
  ].join("");
}
