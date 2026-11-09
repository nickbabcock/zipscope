// The served HTML of the front door: the first view and the rest of the
// page. The build puts it in `index.html` (see `vite.config.ts`), so a
// reader or a search engine has the whole page before any script runs, and
// `door.css` styles it. When the app starts, it moves these elements into the
// door. This module must not use the DOM: the Vite config imports it in Node.
import { door, SOURCE_URL } from "./strings.ts";

/** The ids that the app needs. Tests and `door.css` use the same ids. */
export const DOOR_IDS = {
  heading: "door-h1",
  tagline: "door-tagline",
  frame: "door-frame",
  page: "door-page",
  rest: "explainer",
} as const;

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

/** Puts each key name of the keyboard answer in a `<kbd>` element. A key is
 *  a whole word: "Space" in "Space shows", not in other words. */
function withKeys(html: string): string {
  const names = door.keys.map((key) => key.replace(/[/]/g, "\\/")).join("|");
  return html.replace(
    new RegExp(`(^|[\\s(])(${names})(?=[\\s,.)])`, "g"),
    (_, before: string, key: string) => `${before}<kbd>${key}</kbd>`,
  );
}

/** The slot of a "See it" control. Solid draws the control. */
const see = (answer: string) => `<span class="door-see" id="door-see-${answer}"></span>`;

/** The Lucide `triangle-alert` icon at 16 px, as the tool draws it. */
const WARN_ICON =
  '<svg class="door-icon" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

/** The slot of a size bar of the tool, in pixels. */
const BAR_SLOT = 48;
/** The least width of a bar of the tool, in pixels (`hasBar` in `view/model.ts`). */
const BAR_MIN = 3;

/** A row of the sample on the pitch of the tool: name, bar and size. An SVG
 *  gives the width of the bar, because the CSP blocks inline styles. */
function sampleRow(row: { name: string; size: string; share: number }): string {
  const width = (row.share / 100) * BAR_SLOT;
  const bar =
    width >= BAR_MIN
      ? `<svg width="${BAR_SLOT}" height="6" aria-hidden="true"><rect width="${width}" height="6" rx="1"/></svg>`
      : "";
  return `<tr><th scope="row">${escape(row.name)}</th><td class="door-row-bar">${bar}</td><td class="door-row-size">${escape(row.size)}</td></tr>`;
}

function questions(): string {
  const { contents, space, health } = door;
  /** The hidden start of each answer. */
  const prefix = `<span class="door-hidden">${escape(door.samplePrefix)}</span>`;
  return [
    `<section id="door-questions" aria-describedby="door-demo">`,
    `<p id="door-demo"><span class="door-tag">Demo</span> ${copy(door.demoLabel)}</p>`,
    `<div class="door-q" id="door-q-contents">`,
    `<h2>${escape(contents.question)}</h2>`,
    `<p class="door-a">${prefix}${copy(contents.answer)} ${see("contents")}</p>`,
    `</div>`,
    `<div class="door-q" id="door-q-space">`,
    `<h2>${escape(space.question)}</h2>`,
    `<p class="door-a">${prefix}${copy(space.answer)} ${see("space")}</p>`,
    `<div id="door-bar" role="img" aria-label="${escape(space.shareName)}"><div id="door-bar-track"><div id="door-bar-fill"></div></div><span id="door-bar-share">${space.share}</span></div>`,
    `<table id="door-rows"><caption>${escape(space.rowsLabel)}</caption><tbody>${space.rows.map(sampleRow).join("")}</tbody></table>`,
    `</div>`,
    `<div class="door-q" id="door-q-health">`,
    `<h2>${escape(health.question)}</h2>`,
    `<p class="door-a">${prefix}${WARN_ICON}<strong class="door-warn">${escape(health.counts)}</strong> ${copy(health.answer)} ${see("health")}</p>`,
    `</div>`,
    `</section>`,
  ].join("");
}

function actionRow(): string {
  const { action, noScript } = door;
  return [
    `<div id="door-row">`,
    `<p id="door-action">`,
    `<span class="door-line" data-line="fine">${escape(action.fine)}</span>`,
    `<span class="door-line" data-line="coarse">${escape(action.coarse)}</span>`,
    `<span class="door-line" data-line="dragging">${escape(action.dragging)}</span>`,
    `<span class="door-line" data-line="compact">${escape(action.compact)}</span>`,
    `</p>`,
    `<noscript><p id="door-noscript">${escape(noScript)}</p></noscript>`,
    `<p id="door-failed" hidden>${escape(noScript)}</p>`,
    `<div id="door-buttons"></div>`,
    `</div>`,
  ].join("");
}

function rest(): string {
  const pair = (question: string, answer: string, after = "") =>
    `<div class="door-pair"><h2>${escape(question)}</h2><p>${answer}</p>${after}</div>`;
  const { files, reads, lies, inside, device, keyboard, close } = door;
  return [
    `<section id="${DOOR_IDS.rest}">`,
    // The first question of a person with a large file. It is not the lead of
    // the page, but it is the first answer here.
    pair(
      device.question,
      `${copy(device.answer)}<a href="${SOURCE_URL}">${escape(device.link)}</a>.`,
      `<p id="front-test"></p>`,
    ),
    pair(files.question, copy(files.answer)),
    pair(reads.question, copy(reads.answer)),
    pair(lies.question, copy(lies.answer)),
    pair(inside.question, copy(inside.answer)),
    pair(keyboard.question, withKeys(copy(keyboard.answer))),
    ...door.formats.map((format) => pair(format.question, copy(format.answer))),
    `<div id="door-close"><h2>${escape(close)}</h2></div>`,
    `</section>`,
  ].join("");
}

/** Returns the head tags that need the production origin. With no origin,
 *  the build is a preview or a local build, so it returns only a tag that
 *  keeps search engines from indexing the page. */
export function originTags(
  origin: string | undefined,
): { tag: string; attrs: Record<string, string> }[] {
  const base = origin?.replace(/\/+$/, "");
  if (base === undefined || base === "") {
    return [{ tag: "meta", attrs: { name: "robots", content: "noindex" } }];
  }
  return [
    { tag: "link", attrs: { rel: "canonical", href: `${base}/` } },
    { tag: "meta", attrs: { property: "og:url", content: `${base}/` } },
    { tag: "meta", attrs: { property: "og:image", content: `${base}/og.png` } },
  ];
}

/** Returns the HTML in the place of the root element: the hidden heading
 *  first, the root element, and then the frame of the static page. */
export function doorHtml(): string {
  return [
    `<h1 id="${DOOR_IDS.heading}">${escape(door.heading)}</h1>`,
    `<div id="root"></div>`,
    `<div id="${DOOR_IDS.frame}">`,
    `<div id="door-top"><span id="door-mark">Zipscope</span><span id="${DOOR_IDS.tagline}">${escape(door.tagline)}</span></div>`,
    `<main id="door-work"><div id="${DOOR_IDS.page}">`,
    questions(),
    actionRow(),
    // The slot of the recent archives. The app fills it when the browser
    // keeps file handles.
    `<div id="door-recent"></div>`,
    rest(),
    `</div></main>`,
    `<div id="door-margin"></div>`,
    `</div>`,
  ].join("");
}
