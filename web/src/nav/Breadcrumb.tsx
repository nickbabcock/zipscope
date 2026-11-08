// The breadcrumb in the header strip of the table. It shows the path of
// the listed folder with the same compact chains as the tree: each segment
// is one tree row from the root row to the row of the listed folder.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { NONE } from "../contracts";
import type { Frame, FrameLoop, Prepared } from "../grid/frame";
import type { MirrorReader } from "../store/reader";
import type { ViewSet } from "../store/reader";
import { ANCHORS } from "../grid/anchors";
import { chainTruncate, fontOf, TextWidths } from "../grid/truncate";
import { directed, nameLabel, nameText, nameTitle } from "../label";
import { color } from "../theme/tokens.stylex";
import { controls } from "../shell/controls";
import { COARSE_POINTER } from "../grid/scroll";
import { treeIndexOf, treeRow, walkChain } from "../view/model";
import type { Crumb } from "./navigation";
import { STOPPED_ID } from "../health/findings";

export interface BreadcrumbProps {
  reader: MirrorReader;
  loop: FrameLoop;
  archiveName: string;
  /** True while the table shows search results. */
  searching: boolean;
  /** The folder of the current history entry, or undefined for the
   *  landing folder. Search results show the path of this folder. */
  folder: number | undefined;
  /** The narrow layout hides the archive name: the top bar shows it. */
  narrow: boolean;
  /** True after the hard stop. Then the worker refuses each folder
   *  change and search, so a segment that would send one is off. */
  stopped: boolean;
  onNavigate: (folder: number) => void;
  /** The root segment opens the Archive panel. */
  onRoot: () => void;
  /** Reports the listed folder and the segments after each change. */
  onReport: (folder: number | undefined, crumbs: readonly Crumb[]) => void;
}

/**
 * Returns the segments of a folder: the tree rows from the root row to the
 * row of the folder. Returns undefined when a folder cannot show yet, and
 * [] when the folder has no row.
 */
export function crumbsOf(
  reader: Pick<MirrorReader, "folderName" | "folderParent">,
  views: ViewSet,
  folders: number,
  folder: number,
  archiveName: string,
): Crumb[] | undefined {
  const index = treeIndexOf(views.tree, views.treeRows, folder);
  if (index < 0) {
    return [];
  }
  const rows = [treeRow(views.tree, index)];
  for (let row = index - 1; row >= 0 && rows[0]!.level > 0; row--) {
    const above = treeRow(views.tree, row);
    if (above.level < rows[0]!.level) {
      rows.unshift(above);
    }
  }
  const crumbs: Crumb[] = [];
  for (const row of rows) {
    if (row.folder >= folders) {
      return undefined;
    }
    const root = row.level === 0;
    const label = root
      ? archiveName
      : walkChain(reader, row.folder, { steps: row.chain }).names.join("/");
    crumbs.push({ folder: row.folder, label, root });
  }
  return crumbs;
}

export function Breadcrumb(props: BreadcrumbProps) {
  const [crumbs, setCrumbs] = createSignal<readonly Crumb[]>([]);

  onSettled(() => {
    /** The last folder that the table listed. */
    let listed: number | undefined;
    let key = "";
    const render = (frame: Frame): Prepared => {
      const views = frame.views;
      if (views === undefined) {
        return { complete: true, commit: () => {} };
      }
      // Search results have no folder in the views. They show the folder
      // of the history entry, which Back can change during a search.
      const folder = views.folder === NONE ? (props.folder ?? listed) : views.folder;
      const next =
        folder === undefined
          ? []
          : crumbsOf(props.reader, views, frame.folders, folder, props.archiveName);
      return {
        complete: next !== undefined,
        commit: () => {
          if (next === undefined) {
            props.loop.schedule();
            return;
          }
          listed = folder;
          const nextKey = `${folder}:${next.map((crumb) => `${crumb.folder}/${crumb.label}`).join("\n")}`;
          if (nextKey !== key) {
            key = nextKey;
            setCrumbs(next);
            props.onReport(folder, next);
          }
        },
      };
    };
    return props.loop.add({ render });
  });

  /** The width of the location, from a resize observer. */
  const [room, setRoom] = createSignal(0);
  const widths = new TextWidths();
  /** The segments in the root and folder order. The narrow layout has no
   *  root segment: the top bar names the archive. */
  const all = () =>
    props.narrow && crumbs().length > 1 ? crumbs().filter((crumb) => !crumb.root) : crumbs();
  /** The middle segments that do not fit go into one menu, from the first
   *  up, so the root and the folders nearest the current folder stay whole. */
  const fit = createMemo(() => {
    const list = all();
    const width = room();
    if (width === 0) return { shown: list, hidden: [] as Crumb[], at: -1, cut: undefined };
    // The current segment is bold, so the widths have a margin.
    const measure = (text: string) => widths.measure(text) * 1.08;
    const cost = (crumb: Crumb) => measure(nameText(crumb.label)) + SLASH;
    let used = list.reduce((sum, crumb) => sum + cost(crumb), 0);
    if (used <= width) return { shown: list, hidden: [] as Crumb[], at: -1, cut: undefined };
    /** The last segment, when it alone still does not fit: a compact chain
     *  goes from its start and keeps its last folder. */
    const current = list[list.length - 1];
    const cutTo = (over: number) =>
      current === undefined || over <= width
        ? undefined
        : chainTruncate(
            nameText(current.label),
            Math.max(0, width - (over - cost(current)) - SLASH),
            measure,
          );
    if (list.length < 2) return { shown: list, hidden: [] as Crumb[], at: -1, cut: cutTo(used) };
    used += MORE;
    const hidden: Crumb[] = [];
    // The root stays. The narrow layout has no root, so the first folder
    // can go too.
    const start = list[0]!.root ? 1 : 0;
    let first = start;
    while (first < list.length - 1 && used > width) {
      hidden.push(list[first]!);
      used -= cost(list[first]!);
      first++;
    }
    return {
      shown: [...list.slice(0, start), ...list.slice(first)],
      hidden,
      at: start,
      cut: cutTo(used),
    };
  });
  const shown = () => fit().shown;
  const last = (index: number) => !props.searching && index === shown().length - 1;
  /** The text of a segment: the last one can be cut. */
  const text = (crumb: Crumb, index: number) => {
    const cut = index === shown().length - 1 ? fit().cut : undefined;
    return cut === undefined ? nameLabel(crumb.label) : directed(cut);
  };
  /** True for a segment that the hard stop turns off: each segment but
   *  the root of the current location, which only opens the Archive panel
   *  and sends no request. */
  const off = (index: number) => props.stopped && !last(index);

  let more: HTMLDivElement | undefined;
  return (
    <nav
      ref={(el) => {
        const observer = new ResizeObserver(() => {
          // The text font of the location, for the widths of the segments.
          widths.setFont(fontOf(el));
          setRoom(el.clientWidth);
        });
        observer.observe(el);
        onCleanup(() => observer.disconnect());
      }}
      id="location"
      aria-label="Location"
      {...stylex.attrs(styles.nav)}
    >
      <ol {...stylex.attrs(styles.list)}>
        <For each={shown()}>
          {(crumb, index) => (
            <>
              <Show when={index() === fit().at}>
                <li {...stylex.attrs(styles.item, styles.keep)}>
                  <Show when={index() > 0}>
                    <span aria-hidden="true" {...stylex.attrs(styles.slash)}>
                      /
                    </span>
                  </Show>
                  <button
                    id="location-more"
                    type="button"
                    aria-label="Show the hidden folders of the location"
                    title="Show the hidden folders of the location"
                    popovertarget="location-menu"
                    {...stylex.attrs(
                      styles.more,
                      COARSE_POINTER && styles.moreCoarse,
                      controls.focusRing,
                    )}
                  >
                    …
                  </button>
                  <div
                    ref={(el) => (more = el)}
                    id="location-menu"
                    popover="auto"
                    {...stylex.attrs(styles.menu, ANCHORS && styles.menuAnchored)}
                    onToggle={(event) => {
                      if (ANCHORS || event.newState !== "open") return;
                      // Chrome 125 to 128 have no `position-area`.
                      const at = document.getElementById("location-more")!.getBoundingClientRect();
                      more!.style.left = `${at.left}px`;
                      more!.style.top = `${at.bottom}px`;
                    }}
                  >
                    <For each={fit().hidden}>
                      {(level) => (
                        <button
                          type="button"
                          data-folder={level.folder}
                          dir="ltr"
                          aria-disabled={props.stopped ? "true" : undefined}
                          aria-describedby={props.stopped ? STOPPED_ID : undefined}
                          onClick={() => {
                            if (props.stopped) return;
                            more?.hidePopover();
                            props.onNavigate(level.folder);
                          }}
                          {...stylex.attrs(styles.menuItem, controls.focusRing)}
                        >
                          {nameLabel(level.label)}
                        </button>
                      )}
                    </For>
                  </div>
                </li>
              </Show>
              <li
                {...stylex.attrs(
                  styles.item,
                  last(index()) ? styles.current : styles.ancestor,
                  crumb.root && styles.root,
                )}
              >
                <Show when={index() > 0 || fit().at === 0}>
                  <span aria-hidden="true" {...stylex.attrs(styles.slash)}>
                    /
                  </span>
                </Show>
                <Show
                  when={!last(index()) || crumb.root}
                  fallback={
                    <span
                      aria-current="location"
                      data-folder={crumb.folder}
                      dir="ltr"
                      title={nameTitle(crumb.label)}
                      {...stylex.attrs(styles.label)}
                    >
                      {text(crumb, index())}
                    </span>
                  }
                >
                  {/* The root stays a button: it opens the Archive panel. */}
                  <button
                    type="button"
                    aria-current={last(index()) ? "location" : undefined}
                    aria-disabled={off(index()) ? "true" : undefined}
                    aria-describedby={off(index()) ? STOPPED_ID : undefined}
                    data-folder={crumb.folder}
                    dir="ltr"
                    title={nameTitle(crumb.label)}
                    onClick={() => {
                      if (off(index())) return;
                      if (crumb.root) props.onRoot();
                      else props.onNavigate(crumb.folder);
                    }}
                    {...stylex.attrs(
                      styles.label,
                      styles.button,
                      controls.focusRing,
                      off(index()) && styles.stopped,
                    )}
                  >
                    {text(crumb, index())}
                  </button>
                </Show>
              </li>
            </>
          )}
        </For>
        <Show when={props.searching}>
          <li {...stylex.attrs(styles.item, styles.current)}>
            <span aria-hidden="true" {...stylex.attrs(styles.slash)}>
              ·
            </span>
            <span aria-current="location" {...stylex.attrs(styles.label)}>
              Search results
            </span>
          </li>
        </Show>
      </ol>
    </nav>
  );
}

const COARSE = "@media (pointer: coarse)";

/** The width of a separator with its space, and of the "…" control. A
 *  coarse pointer gets a "…" of 36 × 36 px in a slot of its own, so that
 *  it takes no taps from the controls next to it. As the rows, it takes
 *  the pointer type when the page loads. */
const SLASH = 16;
const MORE = (COARSE_POINTER ? 36 : 12) + SLASH;

const styles = stylex.create({
  /** It takes the free width of the strip, which is the room to fit. */
  nav: {
    display: "flex",
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  list: {
    alignItems: "center",
    display: "flex",
    listStyle: "none",
    margin: 0,
    minWidth: 0,
    padding: 0,
  },
  item: {
    alignItems: "center",
    display: "flex",
    minWidth: 0,
  },
  keep: {
    flexShrink: 0,
  },
  /** One control for the hidden middle segments: at least 24 × 24 px. */
  more: {
    anchorName: "--location-more",
    backgroundColor: { default: "transparent", ":hover": color.raised },
    borderRadius: 4,
    borderWidth: 0,
    color: color.ink,
    cursor: "pointer",
    font: "inherit",
    height: 24,
    // A 24 px target, and the glyph has the gaps of the other segments.
    marginInline: -6,
    padding: 0,
    width: 24,
  },
  /** For a coarse pointer: 36 × 36 px, and all of it is in the layout. */
  moreCoarse: {
    height: 36,
    marginInline: 0,
    width: 36,
  },
  /** The hidden levels, from the root down. */
  menu: {
    backgroundColor: color.overlay,
    borderColor: color.overlayRule,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: color.shadow,
    color: color.ink,
    flexDirection: "column",
    font: "inherit",
    inset: "auto",
    margin: 0,
    maxWidth: 320,
    padding: 4,
    position: "fixed",
  },
  menuAnchored: {
    positionAnchor: "--location-more",
    positionArea: "block-end span-inline-end",
    positionTryFallbacks: "flip-inline",
  },
  menuItem: {
    backgroundColor: { default: "transparent", ":hover": color.raised },
    borderRadius: 4,
    borderWidth: 0,
    color: "inherit",
    cursor: { default: "pointer", ":is([aria-disabled=true])": "not-allowed" },
    display: "block",
    font: "inherit",
    // A touch screen gets 40 px items, as the row menu.
    minHeight: { default: 28, [COARSE]: 40 },
    overflow: "hidden",
    paddingInline: 8,
    textAlign: "start",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
    width: "100%",
  },
  /** Earlier segments give their room first. */
  ancestor: {
    color: color.inkMuted,
    flexShrink: 1,
  },
  root: {
    flexShrink: 2,
  },
  current: {
    color: color.ink,
    flexShrink: 0,
    fontWeight: 600,
    maxWidth: "100%",
  },
  slash: {
    color: color.inkMuted,
    flexShrink: 0,
    fontWeight: 400,
    marginInline: 4,
  },
  label: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
  },
  /** After the hard stop, as the sort buttons. */
  stopped: {
    color: "inherit",
    cursor: "not-allowed",
    textDecorationLine: "none",
  },
  button: {
    backgroundColor: "transparent",
    borderRadius: 4,
    borderWidth: 0,
    color: { default: "inherit", ":hover": color.ink },
    cursor: "pointer",
    font: "inherit",
    padding: 0,
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
});
