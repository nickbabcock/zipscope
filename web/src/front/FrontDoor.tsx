// The front door: the empty state at `/`. On a first
// visit it is the static page from the served HTML (see `door-static.ts`): the
// word mark, the row of actions, a picture of the tool on the sample archive,
// five bands about what Zipscope does, and a close. This
// component moves the static page into the work area and draws its controls
// in the reserved slots. A drop or the sample archive turns the work area into
// the tool, with no navigation.
//
// Other states:
// - Back from the first entry of an open archive: "Return to name.zip".
// - Chromium keeps the handles of the recent archives. The first door then
//   lists them below the row of actions.
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
import { takeDoor } from "./door-styles";
import { warmSample } from "./sample-client";
import type { SampleUse } from "./sample-names";
import { lifecycle } from "../lifecycle/strings";
import { front, SHOW_OFFLINE_TEST } from "./strings";
import { nameLabel, nameTitle } from "../label";

/** The state of the front door. App derives it, so the door cannot get a
 *  combination that does not occur. The kind is also the `data-state`
 *  value. */
export type Door =
  /** A visit to the home page: the poster. */
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
      document.documentElement.dataset.door = kind === "first" ? "first" : "resume";
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

  const openButton = (primary: boolean, id: string, label: string = front.open) => (
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
      {label}
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

  /** The recent archives: a label, a list of names and sizes, and a
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
          {front.recentHeading}
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
            {...stylex.attrs(styles.linkButton, controls.focusRing)}
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

  /** The picture of the tool on the sample archive. It opens the sample at
   *  the preview of the space hog, as the picture shows it. */
  const shotButton = (picture: Element) => (
    <button
      id="door-shot-button"
      type="button"
      aria-label={front.shotName}
      aria-busy={props.sampleUse === "shot" ? "true" : undefined}
      onClick={() => props.onSample("shot")}
      {...stylex.attrs(styles.shot, controls.focusRing)}
    >
      {picture}
    </button>
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
      fill("door-buttons", openButton(true, "front-open"), sampleButton());
      fill("door-close-buttons", openButton(true, "close-open"));
      fill("door-recent", recentList());
      const picture = staticPage.querySelector("#door-shot picture");
      if (picture !== null) fill("door-shot", shotButton(picture));
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
            <div {...stylex.attrs(styles.state)}>
              <div {...stylex.attrs(styles.stateRow)}>
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
                {openButton(false, "other-open", front.openOther)}
              </div>
            </div>
          )}
        </Match>
        <Match when={props.door.kind === "reopen" && props.door}>
          {(door) => (
            // At the top, on the axis of the poster, so the door does not
            // move to another place after a reload.
            <div {...stylex.attrs(styles.state)}>
              <h2 id="reopen-text" {...stylex.attrs(styles.stateHeading)}>
                {front.reopen}
              </h2>
              <p id="reopen-why" {...stylex.attrs(styles.reopenWhy)}>
                {front.reopenWhy}
              </p>
              <div {...stylex.attrs(styles.stateRow, styles.reopenRow)}>
                <button
                  ref={(el) => (focusTarget = el)}
                  id="reopen-button"
                  type="button"
                  aria-busy={props.sampleUse === "sample" ? "true" : undefined}
                  onClick={() =>
                    door().lost.demo ? props.onSample("sample") : props.onReopen(door().lost)
                  }
                  {...primaryNamed()}
                >
                  <Icon name="archive" />
                  <span {...stylex.attrs(styles.name)} dir="ltr">
                    {front.reopenName(nameLabel(door().lost.name))}
                  </span>
                  <Show when={door().lost.demo}>
                    <DemoTag />
                  </Show>
                </button>
                {openButton(false, "other-open", front.openOther)}
              </div>
              <Show when={door().refused}>
                <p id="reopen-refused" role="status" {...stylex.attrs(styles.reopenRefused)}>
                  {front.reopenRefused}
                </p>
              </Show>
            </div>
          )}
        </Match>
        <Match when={props.door.kind === "receiving"}>
          <div {...stylex.attrs(styles.state)}>
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
  /** A control in the form of a link, in a line of text. */
  linkButton: {
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
  buttonBusy: {
    backgroundColor: color.raised,
    cursor: "progress",
  },
  /** On a phone the two buttons share the row, so it has one edge. */
  action: {
    flexGrow: { default: 0, [NARROW]: 1 },
    fontSize: textSize.lead,
    // The buttons of the door are 44 px high, also for a mouse.
    height: 44,
    justifyContent: "center",
    paddingInline: 14,
  },
  /** The picture is the control: no fill and no edge of a button. */
  shot: {
    backgroundColor: "transparent",
    borderRadius: 8,
    borderStyle: "none",
    cursor: { default: "pointer", ":is([aria-busy])": "progress" },
    display: "block",
    padding: 0,
    width: "100%",
  },
  sampleRest: {
    display: { default: "inline", [TINY]: "none" },
  },
  named: {
    maxWidth: "100%",
  },
  /** The return, reopen and receiving doors: at the top, on the axis of
   *  the poster (see `--door-gutter` in `door.css`). */
  state: {
    alignItems: "flex-start",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    paddingBlock: "clamp(24px, 3vw, 48px)",
    paddingInline: "clamp(16px, 4.5vw, 64px)",
  },
  /** The display face of the poster (see `door.css`). */
  stateHeading: {
    color: color.ink,
    fontFamily: '"Archivo Black", system-ui, sans-serif',
    fontSize: "clamp(36px, 6vw, 72px)",
    fontWeight: 400,
    letterSpacing: "-0.03em",
    lineHeight: 1,
    margin: 0,
    maxWidth: "18ch",
    textWrap: "balance",
  },
  stateRow: {
    columnGap: 12,
    display: "flex",
    flexWrap: "wrap",
    maxWidth: "100%",
    rowGap: 12,
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
  reopenRefused: {
    color: color.inkMuted,
    fontSize: textSize.body,
    margin: 0,
    marginTop: 12,
    maxWidth: "60ch",
  },
  /** The recent archives, directly below the row of actions, on its axis. */
  recent: {
    marginTop: { default: 24, [NARROW]: 20 },
  },
  /** A small label: the list is quieter than the actions above it. */
  recentHeading: {
    color: color.inkMuted,
    fontSize: textSize.body,
    fontWeight: 600,
    lineHeight: 1.4,
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
    marginTop: 24,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});
