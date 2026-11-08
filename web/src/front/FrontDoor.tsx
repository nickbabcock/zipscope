// The front door: the empty state at `/`. On a first visit it is the static
// page from `index.html` (see `door-static.ts`): three questions, each with
// its answer for the sample archive, a sticky row of actions, and more
// questions below the fold. This component moves the static page into the work
// area and draws its controls in the reserved slots. A drop or the sample
// archive turns the work area into the tool, with no navigation.
//
// Other states:
// - Back from the first entry of an open archive: "Return to name.zip".
// - Chromium keeps the handles of the recent archives. The first door and
//   the compact door then list them below the row of actions.
// - A history entry of an archive that is not open, for example after a
//   reload: "Reopen the file to continue".
// - A new tab that waits for the file of another tab, or a window of a
//   file launch that waits for its file: one status line.
//
// A browser that cannot run Zipscope does not load this module. The entry
// module shows that state (`unsupported.ts`).
import * as stylex from "@stylexjs/stylex";
import {
  createEffect,
  createSignal,
  For,
  getOwner,
  Match,
  onSettled,
  runWithOwner,
  Show,
  Switch,
} from "solid-js";
import { formatSize } from "../format";
import type { RecentArchive } from "../lifecycle/remember";
import type { LostArchive } from "../nav/navigation";
import { controls } from "../shell/controls";
import { Icon } from "../shell/icons";
import { color, textSize } from "../theme/tokens.stylex";
import { preload as preloadWorkers } from "../workers";
import { DemoTag } from "./DemoTag";
import { compactStored } from "./door-flag";
import { page, takeDoor } from "./door-styles";
import { warmSample } from "./sample-client";
import type { Answer, SampleUse } from "./sample-names";
import { lifecycle } from "../lifecycle/strings";
import { front, SHOW_OFFLINE_TEST } from "./strings";
import { nameLabel, nameText, nameTitle } from "../label";

/** The state of the front door. App derives it, so the door cannot get a
 *  combination that does not occur. The kind is also the `data-state`
 *  value. */
export type Door =
  /** A first visit: the questions, or the compact row after a first file. */
  | { kind: "first" }
  /** Back from the first entry of the open archive. */
  | { kind: "return"; name: string }
  /** A history entry of an archive that is not open, for example after a
   *  reload. */
  | { kind: "reopen"; lost: LostArchive; refused: boolean }
  /** A new tab that waits for the file from the tab that opened it, or
   *  the window of a file launch (`launch`) that waits for its file. */
  | { kind: "receiving"; launch: boolean };

/** The preload state. The value is also the `data-preloaded` value. */
type Preload = "pending" | "true" | "false";

export interface FrontDoorProps {
  door: Door;
  /** The connection state from `navigator.onLine`. */
  online: boolean;
  onReturn: () => void;
  /** Opens the file picker. */
  onOpen: () => void;
  /** Opens the archive of the reopen door again. */
  onReopen: (lost: LostArchive) => void;
  /** Generates the demo archive and opens it. */
  onSample: (use: SampleUse) => void;
  /** The control that started the sample that is in generation. */
  sampleUse: SampleUse | undefined;
  /** Gets the result of each preload. */
  onPreloaded: (done: boolean) => void;
  /** The recent archives, the newest first. Empty when the browser does
   *  not keep file handles. */
  recent: RecentArchive[];
  /** The name of the last recent archive that did not open. */
  recentLost: string | undefined;
  /** Opens a recent archive. */
  onRecent: (archive: RecentArchive) => void;
  /** Removes all recent archives. */
  onClear: () => void;
}

/** True for a drag with a file. A drag of text or a link cannot open. */
const carriesFile = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;

export function FrontDoor(props: FrontDoorProps) {
  const [preload, setPreload] = createSignal<Preload>("pending");
  const [dragging, setDragging] = createSignal(0);
  const { heading, page: staticPage } = takeDoor();

  let focusTarget: HTMLButtonElement | undefined;
  let shown = true;
  /** Preloads the workers, their wasm and the sample generator. Then a
   *  drop or the sample works without the network. */
  const warmAll = () => {
    setPreload("pending");
    void Promise.all([preloadWorkers(() => shown), warmSample()]).then((done) => {
      if (!shown) return;
      setPreload(done.every(Boolean) ? "true" : "false");
      props.onPreloaded(done.every(Boolean));
    });
  };
  // When the network comes back, a preload that failed is tried again.
  createEffect(
    () => props.online,
    (online) => {
      if (online && preload() === "false") warmAll();
    },
    { defer: true },
  );
  // `door.css` reads this state. The boot script set it for the first paint.
  createEffect(
    () => props.door.kind,
    (kind) => {
      document.documentElement.dataset.door =
        kind !== "first" ? "resume" : compactStored() ? "compact" : "first";
    },
  );
  onSettled(() => {
    warmAll();
    // The tool that had the focus is now hidden.
    if (focusTarget !== undefined && !document.activeElement?.checkVisibility()) {
      focusTarget.focus({ focusVisible: true });
    }
    return () => {
      shown = false;
    };
  });

  const openButton = (primary: boolean, id: string) => (
    <button
      id={id}
      type="button"
      onClick={() => props.onOpen()}
      {...stylex.attrs(
        controls.button,
        controls.focusRing,
        styles.action,
        primary && controls.primary,
      )}
    >
      <Icon name="open" />
      {front.open}
    </button>
  );

  const primaryNamed = () =>
    stylex.attrs(
      controls.button,
      controls.focusRing,
      styles.action,
      controls.primary,
      styles.named,
    );

  /** A "See it" control of an answer. */
  const seeIt = (answer: Answer) => (
    <button
      id={`see-${answer}`}
      type="button"
      aria-label={front.seeNames[answer]}
      aria-busy={props.sampleUse === answer ? "true" : undefined}
      onClick={() => props.onSample(answer)}
      {...stylex.attrs(
        styles.see,
        props.sampleUse === answer && styles.seeBusy,
        controls.focusRing,
      )}
    >
      {front.see}
    </button>
  );

  const sampleButton = () => (
    <button
      id="sample-button"
      type="button"
      aria-busy={props.sampleUse === "sample" ? "true" : undefined}
      onClick={() => props.onSample("sample")}
      {...stylex.attrs(
        controls.button,
        controls.focusRing,
        styles.action,
        props.sampleUse === "sample" && styles.buttonBusy,
      )}
    >
      <Icon name="archive" />
      <span>
        {front.sampleShort}
        <span {...stylex.attrs(styles.sampleRest)}>
          {front.sample.slice(front.sampleShort.length)}
        </span>
      </span>
    </button>
  );

  /** The recent archives: a question, a list of names and sizes, and a
   *  line that says what the browser keeps. The section stays while the
   *  line about a lost archive shows, so its status region is in the page
   *  before its text. */
  const recentList = () => (
    <section
      id="recent"
      aria-labelledby={props.recent.length > 0 ? "recent-heading" : undefined}
      {...stylex.attrs(
        styles.recent,
        props.recent.length === 0 && props.recentLost === undefined && styles.contents,
      )}
    >
      <Show when={props.recent.length > 0}>
        <h2 id="recent-heading" {...stylex.attrs(styles.recentHeading)}>
          {front.recentQuestion}
        </h2>
        <ul id="recent-list" {...stylex.attrs(styles.recentList)}>
          <For each={props.recent}>
            {(archive) => (
              <li {...stylex.attrs(styles.recentItem)}>
                <button
                  type="button"
                  onClick={() => props.onRecent(archive)}
                  {...stylex.attrs(styles.recentRow, controls.focusRing)}
                >
                  <span
                    {...stylex.attrs(styles.name, styles.recentName)}
                    dir="ltr"
                    title={nameTitle(archive.name)}
                  >
                    {nameLabel(archive.name)}
                  </span>
                  <span {...stylex.attrs(styles.recentSize)}>{formatSize(archive.bytes)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <p id="recent-note" {...stylex.attrs(styles.recentNote)}>
          {front.recentNote}{" "}
          <button
            id="recent-clear"
            type="button"
            aria-label={front.recentClearName}
            onClick={() => props.onClear()}
            {...stylex.attrs(styles.see, controls.focusRing)}
          >
            {front.recentClear}
          </button>
        </p>
      </Show>
      <p id="recent-lost" role="status" {...stylex.attrs(styles.recentNote, styles.recentLost)}>
        {props.recentLost === undefined ? "" : front.recentLost(nameLabel(props.recentLost))}
      </p>
    </section>
  );
  // A row that goes (Clear, or an archive that did not open) had the focus.
  // The focus goes to the first row that stays, else to "Open a file".
  let rowCount = 0;
  createEffect(
    () => props.recent.length,
    (count) => {
      const fewer = count < rowCount;
      rowCount = count;
      if (!fewer || document.activeElement !== document.body) return;
      const target =
        document.querySelector<HTMLElement>("#recent-list button") ??
        document.getElementById("front-open");
      target?.focus();
    },
  );

  /** The owner of the door. A `ref` runs with no owner, and the controls that
   *  it draws must go with the door. */
  const owner = getOwner();
  /** Moves the static page into the door, and draws the controls in its
   *  reserved slots. A later door draws new controls in the same slots. */
  const placeFirst = (slot: HTMLElement) => {
    if (staticPage === null) return;
    const fill = (id: string, ...nodes: unknown[]) =>
      staticPage.querySelector(`#${id}`)?.replaceChildren(...(nodes as Node[]));
    runWithOwner(owner, () => {
      fill("door-see-contents", seeIt("contents"));
      fill("door-see-space", seeIt("space"));
      fill("door-see-health", seeIt("health"));
      fill("door-buttons", openButton(true, "front-open"), sampleButton());
      fill("door-recent", recentList());
    });
    slot.append(staticPage);
  };
  // The offline line is true only after the preload. Until then its element
  // is empty and does not show.
  createEffect(
    () => preload() === "true",
    (preloaded) => {
      const line = staticPage?.querySelector("#front-test");
      if (line) line.textContent = preloaded && SHOW_OFFLINE_TEST ? front.test : "";
    },
  );

  return (
    <div
      id="front-door"
      data-state={props.door.kind}
      data-preloaded={preload()}
      data-dragging={dragging() > 0 ? "true" : undefined}
      onDragEnter={(event) => {
        if (carriesFile(event)) setDragging((count) => count + 1);
      }}
      onDragLeave={(event) => {
        if (carriesFile(event)) setDragging((count) => Math.max(0, count - 1));
      }}
      onDrop={() => setDragging(0)}
      {...stylex.attrs(styles.door, dragging() > 0 && styles.dragging)}
    >
      {/* The hidden `h1` of the page comes first in the DOM. */}
      <div
        {...stylex.attrs(styles.contents)}
        ref={(slot) => {
          if (heading !== null) slot.append(heading);
        }}
      />
      <Switch>
        <Match when={props.door.kind === "first"}>
          <div {...stylex.attrs(styles.contents)} ref={placeFirst} />
        </Match>
        <Match when={props.door.kind === "return" && props.door}>
          {(door) => (
            <div {...stylex.attrs(page.pitch, styles.gutterDoor)}>
              <div {...stylex.attrs(styles.compactRow)}>
                <button
                  ref={(el) => (focusTarget = el)}
                  id="return-button"
                  type="button"
                  onClick={() => props.onReturn()}
                  {...primaryNamed()}
                >
                  <Icon name="archive" />
                  <span {...stylex.attrs(styles.name)} dir="ltr">
                    {front.returnTo(nameLabel(door().name))}
                  </span>
                </button>
                {openButton(false, "compact-open")}
              </div>
            </div>
          )}
        </Match>
        <Match when={props.door.kind === "reopen" && props.door}>
          {(door) => (
            // On the gutter of the first front door, not centered, so the
            // door does not move to another axis after a reload.
            <div {...stylex.attrs(page.pitch, styles.gutterDoor)}>
              <h2 id="reopen-text" {...stylex.attrs(page.unsupported)}>
                {front.reopen}
              </h2>
              <p id="reopen-why" {...stylex.attrs(styles.reopenWhy)}>
                {front.reopenWhy}
              </p>
              {/* The remembered location belongs to the archive button,
                  so it is directly below it. */}
              <div {...stylex.attrs(styles.reopen)}>
                <button
                  ref={(el) => (focusTarget = el)}
                  id="reopen-button"
                  type="button"
                  aria-label={front.reopenName(nameText(door().lost.name))}
                  aria-busy={props.sampleUse === "sample" ? "true" : undefined}
                  onClick={() =>
                    door().lost.demo ? props.onSample("sample") : props.onReopen(door().lost)
                  }
                  {...primaryNamed()}
                >
                  <Icon name="archive" />
                  <span {...stylex.attrs(styles.name)} dir="ltr">
                    {nameLabel(door().lost.name)}
                  </span>
                  <Show when={door().lost.demo}>
                    <DemoTag />
                  </Show>
                </button>
                <Show when={door().refused}>
                  <p id="reopen-refused" role="status" {...stylex.attrs(styles.reopenPlace)}>
                    {front.reopenRefused}
                  </p>
                </Show>
                <Show when={door().lost.state.path}>
                  {(path) => (
                    <p id="reopen-path" dir="ltr" {...stylex.attrs(styles.reopenPlace)}>
                      {front.reopenPath("")}
                      <span {...stylex.attrs(styles.reopenValue)}>{nameLabel(path())}</span>
                    </p>
                  )}
                </Show>
                <Show when={door().lost.state.query}>
                  {(query) => (
                    <p id="reopen-search" dir="ltr" {...stylex.attrs(styles.reopenPlace)}>
                      {front.reopenSearch(nameLabel(query()))}
                    </p>
                  )}
                </Show>
              </div>
              <div {...stylex.attrs(styles.reopenRow)}>{openButton(false, "compact-open")}</div>
            </div>
          )}
        </Match>
        <Match when={props.door.kind === "receiving"}>
          <div {...stylex.attrs(page.pitch, styles.gutterDoor)}>
            <p id="receiving-text" role="status" {...stylex.attrs(styles.receivingText)}>
              {props.door.kind === "receiving" && props.door.launch
                ? lifecycle.launching
                : lifecycle.receiving}
            </p>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

const NARROW = "@media (max-width: 640px)";
const TINY = "@media (max-width: 379px)";
const COARSE = "@media (pointer: coarse)";

const styles = stylex.create({
  door: {
    boxSizing: "border-box",
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    transitionDuration: { default: "200ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    transitionProperty: "background-color",
  },
  dragging: {
    backgroundColor: color.panel,
  },
  contents: {
    display: "contents",
  },
  /** "See it": a control in the form of a link, at the end of an answer. */
  see: {
    backgroundColor: "transparent",
    borderRadius: 2,
    borderStyle: "none",
    color: color.water,
    cursor: "pointer",
    font: "inherit",
    padding: 0,
    textDecorationLine: "underline",
    textDecorationThickness: 1,
    textUnderlineOffset: 3,
  },
  seeBusy: {
    cursor: "progress",
    textDecorationStyle: "dashed",
  },
  buttonBusy: {
    backgroundColor: color.raised,
    cursor: "progress",
  },
  /** On a phone the two buttons share the row, so it has one edge. */
  action: {
    flexGrow: { default: 0, [NARROW]: 1 },
    fontSize: textSize.title,
    // A touch screen gets 44 px buttons.
    height: { default: 36, [COARSE]: 44 },
    justifyContent: "center",
    paddingInline: 14,
  },
  sampleRest: {
    display: { default: "inline", [TINY]: "none" },
  },
  named: {
    maxWidth: "100%",
  },
  compactRow: {
    columnGap: 12,
    display: "flex",
    flexWrap: "wrap",
    maxWidth: "100%",
    rowGap: 12,
  },
  gutterDoor: {
    alignItems: "flex-start",
  },
  /** The archive button and its remembered location. */
  reopen: {
    alignItems: "flex-start",
    display: "flex",
    flexDirection: "column",
    marginTop: 24,
    maxWidth: "100%",
    rowGap: 8,
  },
  receivingText: {
    color: color.ink,
    fontSize: textSize.heading,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    margin: 0,
  },
  reopenWhy: {
    color: color.inkMuted,
    fontSize: textSize.lead,
    lineHeight: 1.45,
    margin: 0,
    marginTop: 12,
    maxWidth: "52ch",
    textWrap: "pretty",
  },
  reopenPlace: {
    color: color.inkMuted,
    fontSize: textSize.body,
    margin: 0,
    maxWidth: "60ch",
    overflowWrap: "anywhere",
  },
  /** The remembered folder is the reason to reopen: it is in ink. */
  reopenValue: {
    color: color.ink,
  },
  /** The recent archives, after the row of actions. A rule is above it, as
   *  between the questions. */
  recent: {
    borderTopColor: color.rule,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    paddingBlock: { default: "24px 40px", [NARROW]: "20px 32px" },
    paddingInline: { default: "clamp(16px, 7vw, 112px)", [NARROW]: 16 },
  },
  recentHeading: {
    fontSize: textSize.heading,
    fontWeight: 650,
    letterSpacing: "-0.015em",
    lineHeight: 1.2,
    margin: 0,
  },
  /** The rows of the sample answer have the same width and rules. */
  recentList: {
    listStyle: "none",
    margin: 0,
    marginTop: 12,
    maxWidth: 480,
    padding: 0,
  },
  recentItem: {
    borderTopColor: { default: color.rule, ":first-child": "transparent" },
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  recentRow: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": color.raised },
    borderRadius: 2,
    borderStyle: "none",
    color: color.ink,
    columnGap: 12,
    cursor: "pointer",
    display: "flex",
    font: "inherit",
    fontSize: textSize.body,
    // A touch screen gets 44 px rows.
    height: { default: 32, [COARSE]: 44 },
    padding: 0,
    textAlign: "start",
    width: "100%",
  },
  recentName: {
    color: color.water,
    flexGrow: 1,
    whiteSpace: "nowrap",
    textDecorationLine: "underline",
    textDecorationThickness: 1,
    textUnderlineOffset: 3,
  },
  recentSize: {
    color: color.inkMuted,
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  recentNote: {
    color: color.inkMuted,
    fontSize: textSize.body,
    margin: 0,
    marginTop: 12,
    maxWidth: "60ch",
    overflowWrap: "anywhere",
  },
  /** The empty status line takes no space. */
  recentLost: {
    marginTop: { default: 12, ":empty": 0 },
  },
  reopenRow: {
    display: "flex",
    marginTop: 36,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});
