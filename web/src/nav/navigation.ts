// Navigation and history of the open archive.
//
// `createNavigation` gives the location signals and the navigation
// actions. All code that moves around the archive calls these actions, so
// the push and replace rules stay in one place:
//
//   Push (adds a Back step):
//     openArchive(session)    a new archive opens
//     navigateToFolder(f)     a tree folder, a breadcrumb segment or a
//                             folder row (click or Enter)
//     goUp()                  Backspace: the previous breadcrumb segment
//     showInTree(f, entry)    "show in tree" from search results
//     openArchivePanel()      the archive root in the tree or breadcrumb
//     openPreview(entry)      only in the narrow layout, where the preview
//                             is a full-screen view
//
//   Replace (changes the current entry):
//     selectFolder(f)         the tree selection moves with the arrow keys
//     openPreview(entry)      in the medium and wide layouts
//     closePreview()          goes back instead when the preview pushed
//     search(query)           search typing
//     record(patch)           sort, columns, scroll and selection
//     followCollapse(f)       a collapse in the tree moved the listed
//                             folder up to the collapsed row
//
//   Front door:
//     front()                 true when the current entry is not an entry
//                             of the open archive (Back from its first
//                             entry, or an entry of an older file)
//     lost()                  the archive of the current entry when no
//                             open session has it, for example after a
//                             reload
//     returnToArchive()       goes to the first entry of the open archive
//     restore(state)          after a reload, shows the location of an
//                             entry of the same archive
//
// Back never closes the archive: an entry of the front door only hides
// the tool. The address bar always shows `/`.
//
// The actions make decisions only from plain variables and from the
// navigator state. A signal write shows only after the next flush, so a
// signal read in the same handler gives the old value. The signals are for
// the display.
import { createSignal, onCleanup } from "solid-js";
import type { ArchiveInfo } from "../shell/archive";
import { Navigator } from "./history";
import type { HistoryLike, NavPatch, NavState, Panel } from "./history";

/** One segment of the breadcrumb. */
export interface Crumb {
  /** The last folder of the segment: the folder that it lists. */
  folder: number;
  label: string;
  /** True for the archive root. */
  root: boolean;
}

/** An archive that a history entry names, but that is not open: its name,
 *  its demo flag and the state of the entry. */
export type LostArchive = Pick<ArchiveInfo, "name" | "demo"> & { state: NavState };

export interface NavigationDeps {
  /** Asks the worker to list a folder of the open archive. Rejects when
   *  the worker refused the request: then it did not publish the listing. */
  list(folder: number): Promise<void>;
  /** Asks the worker to search the open archive. Rejects when the worker
   *  refused the request: then it did not publish the results. */
  search(query: string): Promise<void>;
  /** The query of the listing that shows, or "" for a folder listing. */
  shownQuery(): string;
  /** The folder of the listing that shows, or undefined for search
   *  results and before the first listing. */
  shownFolder(): number | undefined;
  /** True in the narrow layout. */
  narrow(): boolean;
  /** The history. Tests give a fake one. */
  history?: HistoryLike;
}

export type Navigation = ReturnType<typeof createNavigation>;

/** Makes the navigation of the app. Call it one time, in a component. */
export function createNavigation(deps: NavigationDeps) {
  const navigator = new Navigator(deps.history ?? window.history);
  let session = "";
  /** The file name of the open archive and its demo flag. */
  let archive: Pick<ArchiveInfo, "name" | "demo"> | undefined;
  /** The folder of the last list request. The worker runs requests in
   *  order, so it lists this folder when its requests are done, also
   *  while the table still shows an older listing. */
  let requested: number | undefined;
  /** The query that the worker has now. */
  let searched = "";
  /** True while the current entry is an entry of the open archive. */
  let live = false;
  /** The folder that the table lists now, as the breadcrumb reported it. */
  let listedFolder: number | undefined;
  /** The segments of the listed folder. */
  let crumbList: readonly Crumb[] = [];

  const [front, setFront] = createSignal(true);
  /** The archive of an entry that no open session has. */
  const lostOf = (state: NavState): LostArchive | undefined =>
    state.session !== "" && state.session !== session && state.name !== null
      ? { name: state.name, demo: state.demo, state }
      : undefined;
  const [lost, setLost] = createSignal<LostArchive | undefined>(lostOf(navigator.state));
  const [query, setQuery] = createSignal("");
  const [panel, setPanel] = createSignal<Panel | null>(null);
  const [preview, setPreview] = createSignal(false);
  const [entry, setEntry] = createSignal<string | null>(null);
  const [row, setRow] = createSignal<number | null>(null);
  /** The folder that the table lists now. The breadcrumb reports it. */
  const [listed, setListed] = createSignal<number>();
  /** The folder that the table lists when the requests are done. */
  const target = () => requested ?? listedFolder;
  /** The folder of the current entry, or undefined for the landing. */
  const [entryFolder, setEntryFolder] = createSignal<number>();
  const [crumbs, setCrumbs] = createSignal<readonly Crumb[]>([]);

  // A view request changes the location at once. When the worker refuses
  // the request (for example at the memory limit), the location goes back
  // to the listing that shows, also in the history entry. Only the last
  // request goes back: a later request replaces the location again.

  /** Asks the worker to list `folder`. */
  const requestList = (folder: number) => {
    requested = folder;
    const id = session;
    deps.list(folder).catch(() => {
      if (id !== session || requested !== folder) return;
      requested = undefined;
      const shown = deps.shownFolder() ?? listedFolder;
      if (live && navigator.state.folder === folder) {
        setEntryFolder(shown);
        navigator.replace({ folder: shown ?? null });
      }
    });
  };

  /** Asks the worker to search for `next`. */
  const requestSearch = (next: string) => {
    searched = next;
    const id = session;
    deps.search(next).catch(() => {
      if (id !== session || searched !== next) return;
      searched = deps.shownQuery();
      setQuery(searched);
      if (live) navigator.replace({ query: searched });
    });
  };

  /** Shows a state: the front door, or the location in the archive. */
  const show = (state: NavState) => {
    live = session !== "" && state.session === session;
    setFront(!live);
    setLost(lostOf(state));
    if (!live) {
      return;
    }
    if (state.folder !== null && state.folder !== target()) {
      requestList(state.folder);
    }
    setQuery(state.query);
    if (state.query !== searched) {
      requestSearch(state.query);
    }
    setEntryFolder(state.folder ?? undefined);
    setPanel(state.panel);
    setPreview(state.preview);
    setEntry(state.entry);
    setRow(state.row);
  };

  /** Pushes an entry of the open archive. The landing entry first gets
   *  the folder that it shows, so Back lists that folder again. */
  const push = (patch: NavPatch) => {
    if (navigator.state.folder === null && listedFolder !== undefined) {
      navigator.replace({ folder: listedFolder });
    }
    show(navigator.push({ previewPushed: false, ...patch }));
  };

  const onPop = (event: PopStateEvent) => {
    const state = navigator.pop(event.state);
    if (state !== undefined) {
      show(state);
    }
  };
  const onHide = () => navigator.flush();
  window.addEventListener("popstate", onPop);
  window.addEventListener("pagehide", onHide);
  onCleanup(() => {
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("pagehide", onHide);
  });

  /** Lists a folder in a new entry. It leaves a search. */
  const navigateToFolder = (folder: number) => {
    const now = navigator.state;
    if (folder === target() && now.query === "" && now.panel === null) {
      return;
    }
    push({ folder, query: "", panel: null });
  };

  return {
    /** True when the front door shows. */
    front,
    /** The archive of the current entry when no open session has it. */
    lost,
    query,
    panel,
    preview,
    entry,
    /** The store row of the entry in the preview, or null. */
    row,
    listed,
    crumbs,
    /** The folder of the current location: of the entry, else the folder
     *  that the table lists. Search results keep it. */
    folder: () => entryFolder() ?? listed(),

    /** A value that changes when the person moves: to another session or
     *  the front door, or to another folder, search or panel. It reads the
     *  navigator state, so it is correct also before a flush. */
    location() {
      const now = navigator.state;
      return JSON.stringify([now.session, now.folder, now.query, now.panel]);
    },

    /** The breadcrumb reports the listed folder and its segments. */
    report(folder: number | undefined, next: readonly Crumb[]) {
      if (folder !== listedFolder) {
        listedFolder = folder;
        setListed(folder);
      }
      crumbList = next;
      setCrumbs(next);
      // The entry keeps the path of the listing for the reopen door. The
      // breadcrumb reports only a change of the listing, which follows the
      // current entry. (The listed folder can be the end of a compact
      // chain, so it can differ from the folder of the entry.)
      const now = navigator.state;
      if (live) {
        const path =
          next
            .filter((crumb) => !crumb.root)
            .map((crumb) => crumb.label)
            .join("/") || null;
        if (path !== now.path) {
          navigator.replace({ path });
          // A listing changes at most at the pace of the user, and a
          // reload can come at once: write the entry now.
          navigator.flush();
        }
      }
    },

    /** Starts the history of a new archive session. */
    openArchive(id: string, opened?: Pick<ArchiveInfo, "name" | "demo">) {
      session = id;
      archive = opened;
      requested = undefined;
      // The worker of the new session has no query and lists no folder yet.
      searched = "";
      listedFolder = undefined;
      crumbList = [];
      setListed(undefined);
      setCrumbs([]);
      setQuery("");
      show(navigator.openSession(id, opened?.name ?? null, opened?.demo ?? false));
    },

    navigateToFolder,

    /** Moves the tree selection to a folder without a new entry. */
    selectFolder(folder: number) {
      show(navigator.replace({ folder, query: "", panel: null }));
    },

    /** Records that the worker now lists `folder`, because a collapse hid
     *  the row of the listed folder. The search stays. */
    followCollapse(folder: number) {
      show(navigator.replace({ folder }));
    },

    /** Goes to the previous breadcrumb segment. In search results, this is
     *  the folder of the search. */
    goUp() {
      const target = searched !== "" ? crumbList.at(-1) : crumbList.at(-2);
      if (target !== undefined) {
        navigateToFolder(target.folder);
      }
    },

    /** Lists the folder of a search result in a new entry and previews the
     *  result. */
    showInTree(folder: number, name?: string, entryRow?: number) {
      push({
        folder,
        query: "",
        panel: null,
        entry: name ?? navigator.state.entry,
        row: name === undefined ? navigator.state.row : (entryRow ?? null),
      });
    },

    /** Opens the Archive panel in the preview pane, in a new entry. */
    openArchivePanel() {
      const now = navigator.state;
      if (now.panel === "archive" && now.preview && now.query === "" && target() === 0) {
        return;
      }
      push({
        folder: 0,
        query: "",
        panel: "archive",
        preview: true,
        previewPushed: deps.narrow(),
      });
    },

    /** Opens the preview of an entry, or of the last entry. */
    openPreview(name?: string, entryRow?: number) {
      const now = navigator.state;
      const patch: NavPatch = {
        preview: true,
        panel: null,
        entry: name ?? now.entry,
        row: name === undefined ? now.row : (entryRow ?? null),
      };
      if (deps.narrow() && !now.preview) {
        push({ ...patch, previewPushed: true });
      } else {
        show(navigator.replace(patch));
        if (!now.preview) navigator.flush();
      }
    },

    /** Closes the preview. When opening it pushed an entry, this goes
     *  back. Opening and closing write the entry at once: a write in `pagehide`
     *  does not reach the entry of a reload in Chromium, so a reload just after
     *  them would lose them. A preview that follows the selection waits for the
     *  interval, because arrow keys are fast. */
    closePreview() {
      if (navigator.state.previewPushed && navigator.state.preview) {
        navigator.back();
      } else {
        show(navigator.replace({ preview: false, panel: null }));
        navigator.flush();
      }
    },

    /** Sets the search query without a new entry. */
    search(next: string) {
      if (next === searched) {
        return;
      }
      setQuery(next);
      navigator.replace({ query: next });
      requestSearch(next);
    },

    /** Records the view settings in the current entry. */
    record(patch: Pick<NavPatch, "sort" | "columns" | "scroll">) {
      if (live) {
        navigator.replace(patch);
      }
    },

    /**
     * Shows the location of `state`, an entry of an earlier session of the
     * same archive: the folder, the search, the panel and the preview. It
     * changes the current entry. It does nothing when the user moved since
     * the archive opened.
     */
    restore(state: NavState) {
      const now = navigator.state;
      if (!live || now.folder !== null || now.query !== "" || now.preview || now.panel !== null) {
        return;
      }
      show(
        navigator.replace({
          folder: state.folder,
          path: state.path,
          query: state.query,
          panel: state.panel,
          preview: state.preview,
          previewPushed: false,
          entry: state.entry,
          row: state.row,
        }),
      );
    },

    /** Goes to the first entry of the open archive. */
    returnToArchive() {
      if (!navigator.returnToSession()) {
        // No entry of the session is known: start again at the landing.
        if (session !== "") {
          show(navigator.openSession(session, archive?.name ?? null, archive?.demo ?? false));
        }
      }
    },
  };
}
