// The panes of one archive: tree, table, splitter and preview, in the
// three layouts. One frame loop renders the tree and the table from the
// same view set.
import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  flush,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { OVERLAP_FINDING } from "../health/findings";
import { NONE } from "../contracts";
import type { SortColumn } from "../contracts";
import { Breadcrumb } from "../nav/Breadcrumb";
import { isBestMatch, SORT_STATUS_ID } from "../view/sort";
import type { Navigation } from "../nav/navigation";
import { shared } from "../view/styles";
import { TABLE_FLOOR } from "../grid/columns";
import { createGridActions } from "../grid/actions";
import { TableView } from "../grid/TableView";
import type { TableApi } from "../grid/TableView";
import type { ArchiveSession } from "../session";
import type { PreviewTarget } from "../preview/target";
import { openPopup } from "../preview/popup";
import type { Popup } from "../preview/popup";
import { HealthStrip } from "../health/HealthStrip";
import { color, size } from "../theme/tokens.stylex";
import { TreeView } from "../tree/TreeView";
import { ColumnPicker } from "./ColumnPicker";
import { createColumns } from "./columns";
import { controls } from "./controls";
import { modified, typing } from "./keys";
import { Icon } from "./icons";
import type { ArchiveView } from "./archive-view";
import type { Layout } from "./layout";
import { PreviewPane } from "./PreviewPane";
import { Splitter } from "./Splitter";
import { ExtractSlot } from "./ExtractSlot";
import { RemuxSlot } from "./RemuxSlot";
import type { ExtractRequest } from "./ExtractSlot";
import { browserStorage, fitWidth, loadWidth, saveWidth } from "./preview-width";

/** True when `folder` is below `ancestor` in the folder table. */
function isBelow(session: ArchiveSession, folder: number, ancestor: number): boolean {
  const reader = session.reader;
  let current = folder;
  for (let step = 0; step < 1 << 16 && current < reader.visibleFolders(); step++) {
    current = reader.folderParent(current);
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

const REDUCED = "@media (prefers-reduced-motion: reduce)";
/** The width of the tree pane and of the splitter, in pixels. */
const TREE_WIDTH = 320;
const SPLITTER_WIDTH = 1;

export interface WorkspaceProps {
  /** The view of the open archive. It does not change: App makes a new
   *  workspace for each session. */
  view: ArchiveView;
  /** The layout. The JavaScript layout decides all layout styles, so the
   *  styles and the controls always agree at the breakpoints. */
  layout: Layout;
  /** The location and the navigation actions. */
  nav: Navigation;
  onSort: (column: SortColumn) => void;
  /** Opens the file picker. */
  onPick: () => void;
}

export function Workspace(props: WorkspaceProps) {
  const view = props.view;
  const session = view.session;
  const name = session.info.name;
  const nav = props.nav;
  const loop = view.loop;
  // The count of listed rows, from each frame. The reader itself is not
  // reactive, so the preview reads this signal.
  const rows = view.rows;
  let panes!: HTMLDivElement;
  let tree!: HTMLElement;
  let drawerButton!: HTMLButtonElement;
  let previewButton!: HTMLButtonElement;
  let table!: HTMLDivElement;

  const layout = () => props.layout;
  /** The tree drawer of the medium and narrow layouts. The wide layout
   *  has no drawer, so a change to it closes the drawer. */
  const [drawerOpen, setDrawerOpen] = createSignal<boolean>(
    (last) => layout() !== "wide" && last === true,
  );
  const previewOpen = nav.preview;
  /** True when the pane shows an entry. The Archive panel uses the same pane,
   *  but it is not the preview that this toggle turns on. */
  const previewPressed = () => previewOpen() && nav.panel() !== "archive";
  const storage = browserStorage();
  const [storedWidth, setStoredWidth] = createSignal(loadWidth(storage));
  const [panesWidth, setPanesWidth] = createSignal(0);
  const drawer = () => layout() !== "wide";
  const narrow = () => layout() === "narrow";
  /** True when the preview is a pane beside the table. */
  const sidePreview = () => previewOpen() && !narrow();
  /** The width for the table, the splitter and the preview together. */
  const area = () => panesWidth() - (layout() === "wide" ? TREE_WIDTH : 0);
  /** The width for the table and the preview together. */
  const available = () => area() - SPLITTER_WIDTH;
  /** The preview gives way only to the least table. Between that and its
   *  own width, the minor columns of the table leave first. */
  const previewWidth = createMemo(() => fitWidth(storedWidth(), available(), TABLE_FLOOR));
  const columns = createColumns({
    narrow,
    previewOpen,
    room: () =>
      panesWidth() === 0 ? undefined : sidePreview() ? available() - previewWidth() : area(),
    onPick: (next) => nav.record({ columns: [...next] }),
  });
  const hidden = columns.hidden;

  // The history entry records the sort of the listing that shows, when it
  // changes. The first value is the sort of the new archive, not a change.
  // The default sort that lands at the end of the parse is not a choice, so
  // the entry keeps no sort: an entry with no sort has the default sort. The
  // best-match order is no choice either. An old search can publish it after a
  // choice, while the sort request runs.
  createEffect(view.listedSort, (sort, last) => {
    if (last !== undefined && untrack(view.sortChosen) && !isBestMatch(sort)) nav.record({ sort });
  });
  createEffect(previewWidth, (width) => {
    panes.style.setProperty("--preview-width", `${width}px`);
  });
  // The scrim covers the top bar while the drawer is open, so the keys do not
  // reach it either. The front door has the top bar and no drawer.
  createEffect(
    () => drawer() && drawerOpen() && !nav.front(),
    (open) => {
      const bar = document.querySelector("header");
      if (bar !== null) bar.inert = open;
    },
  );
  // A handler writes the state and then moves the focus. `flush` applies
  // the writes to the DOM at once, so the target is not inert and shows.
  // The drawer style makes the tree visible at once, with no transition.
  const openDrawer = () => {
    setDrawerOpen(true);
    flush();
    tree.querySelector<HTMLElement>("[role=tree]")?.focus();
  };
  const closeDrawer = (refocus: boolean) => {
    setDrawerOpen(false);
    if (refocus) {
      flush();
      drawerButton.focus();
    }
  };

  // The preview in a popup window. While it is open, the pane preview is
  // closed, and the popup follows the selection.
  let popup: Popup | undefined;
  /** The extraction of the row menu. One at a time. */
  const [extraction, setExtraction] = createSignal<ExtractRequest>();
  /** True when the listed folder has no entries. */
  const [listingEmpty, setListingEmpty] = createSignal(false);
  /** True while the plan or the extraction runs. */
  let extracting = false;
  /** Extracts the listed folder, or the whole archive at the root. */
  const extractListed = () => {
    if (extracting) return;
    const reader = session.reader;
    const names: string[] = [];
    let folder = nav.listed() ?? 0;
    for (let step = 0; step < 1 << 16 && folder !== 0 && folder < reader.visibleFolders(); step++) {
      names.push(reader.folderName(folder));
      folder = reader.folderParent(folder);
    }
    const path = names.length === 0 ? "" : `${names.reverse().join("/")}/`;
    setExtraction({ target: { kind: "folder", path }, label: path === "" ? name : path });
  };
  /** The zstd copy of the archive. One at a time. */
  const [remuxOpen, setRemuxOpen] = createSignal(false);
  let remuxing = false;
  const [popTarget, setPopTarget] = createSignal<PreviewTarget>();
  const paneTarget = (): PreviewTarget | undefined => {
    const name = nav.entry();
    const row = nav.row();
    return name === null || row === null ? undefined : { row, name };
  };
  const closePopup = () => {
    popup?.close();
    popup = undefined;
  };
  onCleanup(closePopup);
  const onPageHide = () => closePopup();
  window.addEventListener("pagehide", onPageHide);
  onCleanup(() => window.removeEventListener("pagehide", onPageHide));
  const popOut = () => {
    const target = paneTarget();
    setPopTarget(target);
    const opened = openPopup({
      session,
      target: popTarget,
      rows,
      onCheck: view.onCheck,
      onCrcFailure: view.onCrcFailure,
      onClosed: () => {
        popup = undefined;
        // The preview goes back to the pane.
        const last = popTarget();
        nav.openPreview(last?.name, last?.row);
      },
    });
    if (opened === undefined) return;
    closePopup();
    popup = opened;
    nav.closePreview();
  };

  const openPreview = (name?: string, row?: number) => {
    // The pane preview takes the place of the popup.
    closePopup();
    nav.openPreview(name, row);
    if (narrow()) {
      flush();
      document.getElementById("preview-back")?.focus();
    }
  };
  /** Previews an entry that a person chose. An open popup shows it. */
  const openEntry = (name: string, row: number) => {
    if (popup === undefined) {
      openPreview(name, row);
    } else {
      setPopTarget({ row, name });
      popup.focus();
    }
  };
  // The full-screen preview closes with its Back button, Escape or the
  // Back of the browser. The focus goes back to the table. A close from
  // the side pane (its Close button or Escape) removes the focused
  // element; then the focus goes to the Preview button, which opens the
  // preview again. The effect runs after the DOM shows the change.
  createEffect(previewOpen, (open, was) => {
    if (
      was === true &&
      !open &&
      popup === undefined &&
      (narrow() || document.activeElement === document.body)
    ) {
      previewButton.focus();
    }
  });

  const onResize = (width: number, done: boolean) => {
    setStoredWidth(width);
    if (done) {
      saveWidth(storage, width);
    }
  };
  const widthAt = (clientX: number) =>
    fitWidth(
      panes.getBoundingClientRect().right - clientX - SPLITTER_WIDTH / 2,
      available(),
      TABLE_FLOOR,
    );

  const actions = createGridActions({ reader: session.reader, nav });
  /** The name of a listed row, for the examples of health findings. */
  const exampleName = (row: number) =>
    row < session.reader.visibleRows() ? session.reader.name(row) : undefined;
  let grid!: TableApi;
  /** The "Show entry" link of a finding: lists the folder of a row, selects
   *  the row and previews it. The preview adds to the history what it adds
   *  for each request. A chosen sort that lands starts its listing at the top
   *  with no selection, so the link waits for a sort that runs. When the person
   *  moved during the wait, the link does nothing. This workspace is for one
   *  session, so another archive removes the table, which then does nothing. */
  const showEntry = (row: number) => {
    const name = exampleName(row);
    if (name === undefined) return;
    const location = nav.location();
    void view.sorted().then(() =>
      grid.showRow(
        row,
        (folder) => {
          if (folder !== NONE) nav.navigateToFolder(folder);
          openEntry(name, row);
        },
        () => nav.location() === location,
      ),
    );
  };

  /** The selected file of the table, or undefined when a folder or no
   *  row is selected. The Preview button opens it. */
  let selection: PreviewTarget | undefined;
  // The preview follows the selected entry while it is open. In the
  // medium and wide layouts, that replaces the history entry. A folder
  // selection keeps the last file in the preview.
  const onSelectEntry = (name: string | undefined, row: number | undefined) => {
    selection = name === undefined || row === undefined ? undefined : { name, row };
    if (name === undefined || row === undefined) return;
    if (popup !== undefined) {
      setPopTarget({ row, name });
    } else if (previewOpen() && !narrow()) {
      nav.openPreview(name, row);
    }
  };
  const togglePreview = (name: string | undefined, row: number | undefined) => {
    if (previewOpen()) {
      nav.closePreview();
    } else {
      openPreview(name, row);
    }
  };

  /** The link of the Archive panel: opens the health list and moves to
   *  it. The full-screen preview of the narrow layout covers the list, so
   *  it closes first. */
  const showHealth = () => {
    if (narrow()) nav.closePreview();
    if (!view.healthOpen()) view.toggleHealth();
    flush();
    document.getElementById("health-panel")?.scrollIntoView({ block: "nearest" });
  };

  // In the drawer, a click on a folder selects it and closes the drawer.
  const onTreeClick: JSX.EventHandler<HTMLElement, MouseEvent> = (event) => {
    const target = event.target;
    if (
      drawer() &&
      target.closest("[role=treeitem]") !== null &&
      target.closest('[data-part="toggle"]') === null
    ) {
      closeDrawer(true);
    }
  };

  // Escape closes the drawer, also before the focus moves into it.
  // Backspace goes up a level, or closes the full-screen preview.
  const onKeyDown = (event: KeyboardEvent) => {
    if (nav.front()) {
      return;
    }
    if (event.key === "Escape" && drawer() && drawerOpen()) {
      closeDrawer(true);
    } else if (
      event.key === "Backspace" &&
      !event.defaultPrevented &&
      !modified(event) &&
      !typing(event.target)
    ) {
      // The grid handles its own Backspace and prevents the default.
      event.preventDefault();
      if (narrow() && previewOpen()) {
        nav.closePreview();
      } else if (!view.stopped()) {
        // After the hard stop, the worker refuses the folder change.
        actions.goUp();
      }
    }
  };

  onSettled(() => {
    setPanesWidth(panes.clientWidth);
    const observer = new ResizeObserver(() => setPanesWidth(panes.clientWidth));
    observer.observe(panes);
    document.addEventListener("keydown", onKeyDown);
    // A scroll event does not bubble, so listen in the capture phase.
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.id === "list-viewport") {
        nav.record({ scroll: event.target.scrollTop });
      }
    };
    table.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKeyDown);
      table.removeEventListener("scroll", onScroll, { capture: true });
    };
  });

  return (
    <div
      ref={(el) => (panes = el)}
      id="panes"
      data-layout={layout()}
      data-preview={previewOpen() ? "open" : "closed"}
      {...stylex.attrs(
        styles.panes,
        layout() === "wide" && styles.panesWide,
        sidePreview() && (layout() === "wide" ? styles.wideWithPreview : styles.withPreview),
      )}
    >
      {/* Outside the panes, which can be inert, so a screen reader always
          hears a refusal. */}
      <div id="view-refused" role="status" {...stylex.attrs(controls.visuallyHidden)}>
        {view.refusal()}
      </div>
      <nav
        ref={(el) => (tree = el)}
        id="tree-pane"
        aria-label="Folders"
        inert={drawer() && !drawerOpen()}
        onClick={onTreeClick}
        {...stylex.attrs(
          styles.pane,
          styles.tree,
          drawer() && styles.drawer,
          drawer() && drawerOpen() && styles.drawerOpen,
        )}
      >
        <div {...stylex.attrs(controls.strip)}>
          {/* At the start, so "Size" stays over the sizes. */}
          <Show when={drawer()}>
            <button
              type="button"
              aria-label="Hide folders"
              title="Hide folders"
              onClick={() => closeDrawer(true)}
              {...stylex.attrs(controls.iconButton, controls.focusRing, styles.edgeStart)}
            >
              <Icon name="close" />
            </button>
          </Show>
          <span {...stylex.attrs(controls.label)}>Folders</span>
          <span {...stylex.attrs(controls.spacer)} />
          <span {...stylex.attrs(controls.label)}>Size</span>
        </div>
        <div {...stylex.attrs(styles.fill)}>
          <TreeView
            reader={session.reader}
            loop={loop}
            archiveName={name}
            stopped={view.stopped()}
            onSelect={(folder, pointer) => {
              if (!pointer) {
                nav.selectFolder(folder);
              } else if (folder === 0) {
                nav.openArchivePanel();
              } else {
                nav.navigateToFolder(folder);
              }
            }}
            onToggle={(folder, open) => {
              // A collapse above the listed folder makes the worker list
              // the collapsed row. The history entry follows when the
              // worker published that listing, not when it refused the
              // request.
              const current = nav.folder();
              const follows = !open && current !== undefined && isBelow(session, current, folder);
              session.expand(folder, open).then(
                () => {
                  if (follows && nav.folder() === current) nav.followCollapse(folder);
                },
                () => {},
              );
            }}
          />
        </div>
      </nav>
      <Show when={drawer() && drawerOpen()}>
        <div
          id="drawer-scrim"
          aria-hidden="true"
          onClick={() => closeDrawer(false)}
          {...stylex.attrs(styles.scrim, controls.fadeIn)}
        />
      </Show>
      <section
        id="table-pane"
        aria-label="Entries"
        inert={(narrow() && previewOpen()) || (drawer() && drawerOpen())}
        {...stylex.attrs(styles.pane)}
      >
        <div {...stylex.attrs(controls.strip, controls.toolStrip)}>
          <Show when={drawer()}>
            <button
              ref={(el) => (drawerButton = el)}
              id="drawer-button"
              type="button"
              aria-label="Show folders"
              title="Show folders"
              aria-expanded={drawerOpen() ? "true" : "false"}
              aria-controls="tree-pane"
              onClick={() => (drawerOpen() ? closeDrawer(false) : openDrawer())}
              {...stylex.attrs(controls.iconButton, controls.focusRing, styles.edgeStart)}
            >
              <Icon name="folderTree" />
            </button>
          </Show>
          <Breadcrumb
            reader={session.reader}
            loop={loop}
            archiveName={name}
            searching={nav.query() !== ""}
            folder={nav.folder()}
            narrow={narrow()}
            stopped={view.stopped()}
            onNavigate={nav.navigateToFolder}
            onRoot={nav.openArchivePanel}
            onReport={nav.report}
          />
          <output
            id={SORT_STATUS_ID}
            aria-live="polite"
            {...stylex.attrs(shared.muted, styles.sortStatus)}
          >
            {view.sortStatus()}
          </output>
          <Show when={nav.query() === ""}>
            {/* A folder with no entries has nothing to extract, so the
                button is off. */}
            <button
              id="folder-extract"
              type="button"
              aria-label="Extract this folder"
              title={listingEmpty() ? "This folder has no entries" : "Extract this folder"}
              disabled={listingEmpty()}
              onClick={extractListed}
              {...stylex.attrs(controls.tool, controls.focusRing)}
            >
              <Icon name="download" />
              <span {...stylex.attrs(controls.toolLabel)}>
                {previewPressed() ? "Extract folder" : "Extract"}
              </span>
            </button>
          </Show>
          <Show when={!narrow()}>
            <ColumnPicker
              hidden={hidden()}
              blocked={columns.blocked()}
              onChange={columns.pick}
              off={listingEmpty()}
            />
          </Show>
          <button
            ref={(el) => (previewButton = el)}
            id="preview-button"
            type="button"
            aria-label="Preview"
            title="Preview"
            aria-pressed={previewPressed() ? "true" : "false"}
            aria-controls="preview-pane"
            disabled={listingEmpty() && !previewOpen()}
            onClick={() =>
              previewPressed() ? nav.closePreview() : openPreview(selection?.name, selection?.row)
            }
            {...stylex.attrs(
              controls.tool,
              controls.focusRing,
              styles.edgeEnd,
              previewPressed() && controls.pressed,
            )}
          >
            <Icon name="eye" />
            <span {...stylex.attrs(controls.toolLabel)}>Preview</span>
          </button>
        </div>
        <HealthStrip
          findings={view.findings()}
          exampleName={exampleName}
          pause={view.health.pause()}
          onAnswer={view.health.answer}
          stopped={view.stopped()}
          onShowEntry={showEntry}
          open={view.healthOpen()}
          onToggle={view.toggleHealth}
        />
        <div ref={(el) => (table = el)} {...stylex.attrs(styles.fill)}>
          <TableView
            reader={session.reader}
            overlapError={view.findings().some((finding) => finding.id === OVERLAP_FINDING)}
            loop={loop}
            hidden={hidden()}
            sort={view.sort()}
            sortStopped={view.stopped()}
            foldersStopped={view.stopped()}
            onSort={props.onSort}
            listingKey={`${nav.query()}\n${view.listingOrder()}`}
            locationFolder={nav.query() === "" ? nav.folder() : undefined}
            actions={actions}
            onExpand={(folder, open, deep) => {
              session.expandInline(folder, open, deep).catch(() => {});
            }}
            api={(api) => (grid = api)}
            onOpenEntry={openEntry}
            onSelect={onSelectEntry}
            firstRowReady={(set) => view.firstRowReady(nav.query(), set)}
            onFirstRowDone={view.dropFirstRow}
            revealFocus={view.reveal !== undefined}
            onEmpty={setListingEmpty}
            onPick={props.onPick}
            onTogglePreview={togglePreview}
            onClosePreview={() => {
              if (previewOpen()) nav.closePreview();
            }}
            entryFolder={(row) => session.entryFolder(row)}
            onExtract={(target) => {
              if (extracting) return;
              setExtraction({
                target:
                  target.kind === "entry"
                    ? { kind: "entry", row: target.row }
                    : { kind: "folder", path: target.path },
                label: target.path,
              });
            }}
          />
        </div>
      </section>
      <Show when={sidePreview()}>
        <Splitter
          width={previewWidth()}
          widthAt={widthAt}
          onResize={onResize}
          inert={drawer() && drawerOpen()}
        />
      </Show>
      <Show when={previewOpen()}>
        <PreviewPane
          session={session}
          target={paneTarget()}
          rows={rows()}
          onCheck={view.onCheck}
          onCrcFailure={view.onCrcFailure}
          onPopOut={narrow() ? undefined : popOut}
          entry={nav.entry() ?? undefined}
          archive={nav.panel() === "archive" ? name : undefined}
          narrow={narrow()}
          inert={drawer() && drawerOpen()}
          onClose={nav.closePreview}
          findings={view.findings()}
          onShowHealth={showHealth}
          onRemux={() => {
            if (!remuxing) setRemuxOpen(true);
          }}
        />
      </Show>
      <Show when={extraction()} keyed>
        {(request) => (
          <ExtractSlot
            session={session}
            request={request}
            view={window}
            onClose={() => setExtraction(undefined)}
            onBusy={(busy) => {
              extracting = busy;
            }}
          />
        )}
      </Show>
      <Show when={remuxOpen()}>
        <RemuxSlot
          session={session}
          view={window}
          onClose={() => {
            if (!remuxing) setRemuxOpen(false);
          }}
          onBusy={(busy) => {
            remuxing = busy;
          }}
        />
      </Show>
    </div>
  );
}

const styles = stylex.create({
  panes: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    minHeight: 0,
    minWidth: 0,
    position: "relative",
  },
  panesWide: {
    gridTemplateColumns: `${size.tree} minmax(0, 1fr)`,
  },
  withPreview: {
    gridTemplateColumns: "minmax(0, 1fr) 1px var(--preview-width)",
  },
  wideWithPreview: {
    gridTemplateColumns: `${size.tree} minmax(0, 1fr) 1px var(--preview-width)`,
  },
  pane: {
    backgroundColor: color.ground,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
  },
  tree: {
    backgroundColor: color.panel,
    borderRightColor: color.rule,
    borderRightStyle: "solid",
    borderRightWidth: 1,
    boxSizing: "border-box",
  },
  /** The tree as a drawer over the table, in the medium and narrow layouts. */
  drawer: {
    boxShadow: color.shadow,
    insetBlock: 0,
    left: 0,
    position: "absolute",
    transform: "translateX(-100%)",
    transitionDuration: { default: "200ms", [REDUCED]: "0s" },
    transitionProperty: "transform, visibility",
    visibility: "hidden",
    // Wider than the tree pane, so that deep names show: 48 px of the
    // table stays visible next to it.
    width: "min(360px, calc(100vw - 48px))",
    zIndex: 3,
  },
  drawerOpen: {
    transform: "none",
    // Show at once, so the tree can take the focus. On close, the
    // visibility changes after the slide.
    transitionProperty: "transform",
    visibility: "visible",
  },
  /** It covers all of the window: the top bar does not look ready while the
   *  drawer is open. A click on it closes the drawer. */
  scrim: {
    backgroundColor: color.scrim,
    inset: 0,
    position: "fixed",
    zIndex: 2,
  },
  fill: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  sortStatus: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  edgeStart: {
    marginInlineStart: -6,
  },
  edgeEnd: {
    marginInlineEnd: -6,
  },
});
