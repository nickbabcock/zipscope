import * as stylex from "@stylexjs/stylex";
import {
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  Show,
  untrack,
} from "solid-js";
import { NONE, SOFT_BUDGET_BYTES } from "./contracts";
import type { SortColumn } from "./contracts";
import { rememberCompact } from "./front/door-flag";
import { takeDoor } from "./front/door-styles";
import { FrontDoor } from "./front/FrontDoor";
import type { Door } from "./front/FrontDoor";
import { buildSample } from "./front/sample-client";
import type { SampleUse } from "./front/sample-names";
import { front } from "./front/strings";
import { createOnline } from "./front/online";
import { createNavigation } from "./nav/navigation";
import { SearchBox } from "./search/SearchBox";
import { keptSort, nextSort } from "./view/sort";
import { openHandoffTab, takeHandoffId } from "./lifecycle/address";
import { LAUNCH_WAIT_MS, takeLaunch, watchLaunches } from "./lifecycle/launch";
import type { LaunchQueue } from "./lifecycle/launch";
import type { RecentArchive } from "./lifecycle/remember";
import { applyUpdate, watchUpdate } from "./lifecycle/update";
import { loadHandoff, loadOpenChoice, loadRemember } from "./lifecycle/load";
import { droppedFile, pickFile, plainFile, takeKeptDrop } from "./lifecycle/pick";
import type { Incoming } from "./lifecycle/pick";
import { lifecycle } from "./lifecycle/strings";
import type { NavState } from "./nav/history";
import type { LostArchive } from "./nav/navigation";
import { ArchiveSession } from "./session";
import { createArchiveView } from "./shell/archive-view";
import type { ArchiveView } from "./shell/archive-view";
import { createLayout } from "./shell/layout";
import { OPENING } from "./shell/phase";
import { StatusBar } from "./shell/StatusBar";
import { TopBar } from "./shell/TopBar";
import { Workspace } from "./shell/Workspace";
import { color, font, size, textSize } from "./theme/tokens.stylex";
import { nameText } from "./label";

/** The time after the start when App removes the old file handles. */
const PRUNE_DELAY_MS = 3000;

type ChoiceModule = Awaited<ReturnType<typeof loadOpenChoice>>;

/** An open archive: its session and its view, in one owner. Disposing
 *  the owner closes the session (its workers stop) and ends the view (its
 *  frame loop and its signals). */
interface Opened {
  session: ArchiveSession;
  view: ArchiveView;
  dispose: () => void;
}

export function App() {
  const isolated = globalThis.crossOriginIsolated === true;
  const online = createOnline();
  let fileInput: HTMLInputElement | undefined;
  const layout = createLayout();
  const narrow = () => layout() === "narrow";
  /** The owner of App. Each archive gets a child owner of it, so the
   *  archive also goes when App goes. */
  const owner = getOwner();
  const [opened, setOpened] = createSignal<Opened>();
  /** The open archive, for the handlers. A signal read in the handler that
   *  wrote it gives the old value until the next flush. */
  let held: Opened | undefined;
  let active: ArchiveSession | undefined;
  const session = () => opened()?.session;
  const view = () => opened()?.view;
  /** The one-time id when another tab opened this tab to give it a file.
   *  Read it before the navigation writes the address. */
  const handoff = takeHandoffId(location, history);
  /** True when a file launch opened this page. The file comes later. */
  const launched = takeLaunch(location, history);
  const [receiving, setReceiving] = createSignal(handoff !== undefined || launched);
  /** The registration of the service worker when a new version waits. */
  const [update, setUpdate] = createSignal<ServiceWorkerRegistration>();
  /** A file that came while an archive is open. The user chooses to
   *  replace the archive or to open the file in a new tab. */
  const [offered, setOffered] = createSignal<Incoming>();
  /** The location that the next file restores when it is the same
   *  archive. The reopen action sets it before it opens the file input. */
  let restoreNext: NavState | undefined;
  /** The sessions whose kept handle did not give the file in this page.
   *  Their reopen action opens the file picker. */
  const failedHandles = new Set<string>();
  /** The session whose kept handle did not give the file. The reopen door
   *  then says that the next click opens the file picker. */
  const [refused, setRefused] = createSignal<string>();
  /** The recent archives of the front door (Chromium). */
  const [recent, setRecent] = createSignal<RecentArchive[]>([]);
  /** The name of the last recent archive that did not open. */
  const [recentLost, setRecentLost] = createSignal<string>();
  /** The chunk of the choice. A choice shows only after it loaded. */
  let choiceModule: ChoiceModule | undefined;

  /**
   * A production build registers the service worker: it caches the app
   * shell and shows the update notice. The install loads the whole shell,
   * so the registration comes after the first work of the page (the
   * preload of the front door, or the parse of the first archive). Then
   * the install does not slow the first listing. The development server
   * registers the worker only for a streamed download.
   */
  let registered = false;
  const registerWorker = () => {
    const container = (navigator as { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
    if (registered || !import.meta.env.PROD || container === undefined) return;
    registered = true;
    void watchUpdate(container, "/sw.js", setUpdate);
  };

  /** Reload of the update notice: the new version activates, and then
   *  this tab reloads. */
  const reloadForUpdate = () => {
    const registration = update();
    if (registration === undefined) return;
    void applyUpdate(registration, navigator.serviceWorker, () => location.reload());
  };

  // The front door lists the kept handles, and an idle task removes the
  // old ones (see `remember.ts`).
  onSettled(() => {
    if (typeof FileSystemFileHandle !== "function") return;
    void loadRemember()
      .then((memory) => memory.recentArchives())
      .then(
        (list) => setRecent(list),
        () => {},
      );
    const timer = setTimeout(
      () =>
        void loadRemember().then(
          (memory) => memory.pruneHandles(),
          () => {},
        ),
      PRUNE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  });

  const nav = createNavigation({
    narrow,
    list: (folder) => active?.list(folder) ?? Promise.resolve(),
    search: (next) => active?.search(next) ?? Promise.resolve(),
    shownQuery: () => active?.shownQuery() ?? "",
    shownFolder: () => {
      const folder = active?.reader.views()?.folder;
      return folder === NONE ? undefined : folder;
    },
  });
  const onSort = (column: SortColumn) => {
    const current = view();
    if (current === undefined || current.stopped()) return;
    current.sortBy(nextSort(current.sort(), column)).catch(() => {});
  };
  const onQuery = (next: string) => nav.search(next);

  /** Counts the requests to open a file. A sample that is still in
   *  generation does not open when a later request came. */
  let requests = 0;

  /**
   * Opens a file. `demo` is true for the demo archive. `restore` is the
   * state of a history entry of an earlier session (after a reload): when
   * the file is the same archive and its parse completes, the location of
   * that entry shows. A different file starts at its root.
   */
  const open = (
    incoming: Incoming,
    {
      demo = false,
      restore = restoreNext,
      reveal,
    }: { demo?: boolean; restore?: NavState; reveal?: SampleUse } = {},
  ) => {
    const file = incoming.file;
    restoreNext = undefined;
    requests += 1;
    // The old archive goes first: its workers stop before the new ones
    // start. When a job of it wrote files, its read and write workers can
    // stop up to JOB_STOP_MS later; the new parse waits for them, and for
    // the workers that the old archive waited for, so two archives do not
    // hold memory at the same time.
    const after = held?.session.closeForNext();
    held?.dispose();
    performance.clearMarks();
    performance.mark("zipscope:open");
    const next = runWithOwner(owner, () =>
      createRoot((dispose): Opened => {
        const made = new ArchiveSession(file, demo, after);
        onCleanup(() => void made.close());
        return { session: made, view: createArchiveView(made, { reveal }), dispose };
      }),
    );
    held = next;
    active = next.session;
    document.title = demo ? `${front.demo}: ${nameText(file.name)} – Zipscope` : "Zipscope";
    setOpened(next);
    nav.openArchive(next.session.id, next.session.info);
    remember(next.session, incoming, restore);
    void next.session.finished.then(registerWorker, registerWorker);
    // After a first real file, this browser gets the compact door. The sample
    // does not count, and a file that does not open does not count.
    if (!demo) {
      void next.session.finished.then((outcome) => {
        if (outcome.kind === "complete") rememberCompact();
      });
    }
  };

  /** Keeps the identity and the handle of the archive for a reload, and
   *  restores the location of `restore` when the archive matches. */
  const remember = (made: ArchiveSession, incoming: Incoming, restore: NavState | undefined) => {
    void loadRemember()
      .then(async (memory) => {
        void incoming.handled.then((handle) => handle && memory.saveHandle(incoming.file, handle));
        const identity = await memory.identify(incoming.file);
        memory.rememberArchive(made.id, identity);
        if (restore === undefined) return;
        if (!memory.sameArchive(memory.rememberedArchive(restore.session), identity)) return;
        const outcome = await made.finished;
        if (outcome.kind !== "complete" || active !== made) return;
        nav.restore(restore);
        restoreSort(held?.view, restore);
      })
      .catch(() => {});
  };

  /** Sorts the listing as the entry of the earlier session did. An
   *  entry that keeps no sort has the default sort. It does
   *  nothing when the user sorted since the archive opened. */
  const restoreSort = (shown: ArchiveView | undefined, restore: NavState) => {
    const sort = keptSort(restore.sort);
    if (sort === undefined || shown === undefined || shown.stopped()) return;
    if (untrack(shown.sortChosen)) return;
    shown.sortBy(sort).catch(() => {});
  };

  /** Opens the file picker. */
  const pick = async () => {
    const picked = await pickFile();
    if (picked === "input") fileInput?.click();
    else if (picked !== undefined) offer(picked);
  };

  /**
   * Opens the archive of a history entry again, after a reload. With a
   * kept handle (Chromium), the browser asks for permission one time; else
   * the file picker opens. When the user refuses the permission, or the
   * file is gone, the door says so and the next click opens the picker:
   * the prompt can use up the user action of this click, and a picker
   * without one does not open.
   */
  const reopen = async (lost: LostArchive) => {
    const session = lost.state.session;
    if (typeof FileSystemFileHandle === "function" && !failedHandles.has(session)) {
      const memory = await loadRemember().catch(() => undefined);
      const identity = memory?.rememberedArchive(session);
      const handle = identity && (await memory?.loadHandle(identity));
      if (memory !== undefined && handle !== undefined) {
        const file = await memory.fileOfHandle(handle);
        if (file !== undefined) {
          open({ file, handle, handled: Promise.resolve(handle) }, { restore: lost.state });
          return;
        }
        failedHandles.add(session);
        setRefused(session);
        return;
      }
    }
    restoreNext = lost.state;
    await pick();
  };

  /**
   * Opens an archive of the list on the front door. The browser asks for
   * the permission one time. When the user refuses it, or the file is gone,
   * the row goes and the door says so. When the file changed its name or
   * its size since the open, the open keeps a new record, so the old record
   * goes.
   */
  const openRecent = async (archive: RecentArchive) => {
    const memory = await loadRemember().catch(() => undefined);
    const file = await memory?.fileOfHandle(archive.handle);
    if (file !== undefined) {
      if (file.name !== archive.name || file.size !== archive.bytes) {
        void memory?.forgetHandle(archive);
      }
      open({ file, handle: archive.handle, handled: Promise.resolve(archive.handle) });
      return;
    }
    setRecent((list) => list.filter((item) => item !== archive));
    setRecentLost(archive.name);
    void memory?.forgetHandle(archive);
  };

  /** Removes all recent archives. */
  const clearRecent = () => {
    setRecent([]);
    setRecentLost(undefined);
    void loadRemember().then(
      (memory) => memory.clearHandles(),
      () => {},
    );
  };

  /**
   * Opens a file that the user dropped or chose. While an archive is open,
   * a drop first asks: Replace or Open in new tab. A drop can be an
   * accident, but the Open button and the file picker are a deliberate
   * action, so a chosen file replaces the archive at once.
   * During a job that writes files, a chosen file asks too, because
   * Replace cancels the job.
   */
  const offer = (incoming: Incoming, { dropped = false }: { dropped?: boolean } = {}) => {
    if (active === undefined || (!dropped && !active.writing())) {
      open(incoming);
      return;
    }
    void loadOpenChoice().then(
      (module) => {
        choiceModule = module;
        setOffered(incoming);
      },
      () => {
        // The chunk did not load: the browser asks, and OK replaces. A
        // native dialog has no safe default button, so during a job that
        // writes files the archive stays, and the browser tells why.
        const name = nameText(active?.info.name ?? "");
        const file = nameText(incoming.file.name);
        if (active?.writing() === true) {
          alert(`${lifecycle.choiceKeptTitle(file)}\n${lifecycle.choiceKept(name)}`);
          return;
        }
        if (confirm(`${lifecycle.choiceTitle(file)}\n${lifecycle.choiceText(name)}`)) {
          open(incoming);
        }
      },
    );
  };

  /** Gives the file to a new tab. This tab keeps its archive. */
  const openInNewTab = (incoming: Incoming) => {
    setOffered(undefined);
    // The tab opens in the click. The channel code loads after it; the new
    // tab sends `ready` again until the file comes.
    const id = openHandoffTab((url) => window.open(url, "_blank", "noopener"));
    void loadHandoff().then(
      ({ sendToNewTab }) => sendToNewTab(incoming, id),
      () => {},
    );
  };

  if (handoff !== undefined) {
    void loadHandoff()
      .then(({ receiveFromOpener }) => receiveFromOpener(handoff))
      .catch(() => undefined)
      .then((received) => {
        setReceiving(false);
        // A file that the user opened in the meantime stays.
        if (received !== undefined && active === undefined) {
          open({ ...received, handled: Promise.resolve(received.handle) });
        }
      });
  }

  // The file of a launch opens as a drop does: with an open archive, the
  // user chooses.
  onSettled(() => {
    /** Ends the wait of a launch. A handoff has its own wait. */
    const endLaunch = () => {
      if (launched) setReceiving(false);
    };
    watchLaunches(
      (window as { launchQueue?: LaunchQueue }).launchQueue,
      (file, handle) => {
        endLaunch();
        offer({ file, handle, handled: Promise.resolve(handle) }, { dropped: true });
      },
      endLaunch,
    );
    if (!launched) return;
    const timer = setTimeout(endLaunch, LAUNCH_WAIT_MS);
    return () => clearTimeout(timer);
  });

  /** The line beside the word mark, from the served HTML. */
  const tagline = takeDoor().tagline;

  /** The control that started the sample. It has `aria-busy`. A second
   *  control during the generation takes its place and starts no more work. */
  const [sampleUse, setSampleUse] = createSignal<SampleUse>();
  /** True after the preload of the front door completed. */
  const [preloaded, setPreloaded] = createSignal(false);
  /** True after the sample could not open, until the next try. */
  const [sampleFailed, setSampleFailed] = createSignal(false);

  /** Generates the demo archive in a worker and opens it. */
  const openSample = async (use: SampleUse) => {
    const running = untrack(sampleUse) !== undefined;
    setSampleUse(use);
    setSampleFailed(false);
    if (running) return;
    const request = ++requests;
    // After a reload of the demo, the same demo gets its location back.
    const lost = nav.lost();
    const restore = lost?.demo === true ? lost.state : undefined;
    try {
      const file = await buildSample();
      // A file that the user opened in the meantime stays.
      if (request === requests) {
        const wanted = untrack(sampleUse);
        open(plainFile(file), {
          demo: true,
          restore,
          reveal: wanted,
        });
      }
    } catch {
      // A file that the user opened in the meantime has its own map margin.
      setSampleFailed(request === requests);
    } finally {
      setSampleUse(undefined);
    }
  };

  // A file that the visitor dropped before the app started.
  const kept = takeKeptDrop();
  onSettled(() => {
    if (kept !== undefined) offer(kept, { dropped: true });
  });

  /** The state of the front door. */
  const door = createMemo<Door>(() => {
    if (session() !== undefined) {
      // The door shows with an open archive only after Back.
      return { kind: "return", name: session()?.info.name ?? "" };
    }
    if (receiving()) return { kind: "receiving", launch: launched };
    const lost = nav.lost();
    return lost === undefined
      ? { kind: "first" }
      : { kind: "reopen", lost, refused: refused() === lost.state.session };
  });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const incoming = droppedFile(event);
    if (incoming !== undefined) {
      offer(incoming, { dropped: true });
    }
  };

  return (
    <div
      {...stylex.attrs(styles.app)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <TopBar
        archive={session()?.info}
        narrow={narrow()}
        hideOpen={
          (session() === undefined || nav.front()) &&
          (door().kind === "first" || door().kind === "reopen")
        }
        onFile={(file) => offer(plainFile(file))}
        onPick={() => void pick()}
        input={(element) => (fileInput = element)}
        plainMark={session() === undefined || nav.front()}
        note={session() === undefined && door().kind === "first" ? tagline : undefined}
        search={
          <Show when={session() !== undefined && !nav.front()}>
            <SearchBox
              query={nav.query()}
              onQuery={onQuery}
              stopped={view()?.stopped() ?? false}
              empty={view()?.phase().kind === "listed" && view()?.rows() === 0}
              onEnter={() => view()?.askFirstRow(nav.query())}
              onLeave={() => view()?.dropFirstRow()}
            />
          </Show>
        }
      />
      <main {...stylex.attrs(styles.main)}>
        <Show when={session() === undefined || nav.front()}>
          <FrontDoor
            door={door()}
            online={online()}
            onReturn={() => nav.returnToArchive()}
            onOpen={() => void pick()}
            onReopen={(lost) => void reopen(lost)}
            onSample={(use) => void openSample(use)}
            sampleUse={sampleUse()}
            recent={recent()}
            recentLost={recentLost()}
            onRecent={(archive) => void openRecent(archive)}
            onClear={clearRecent}
            onPreloaded={(done) => {
              setPreloaded(done);
              registerWorker();
            }}
          />
        </Show>
        {/* Back to the front door hides the tool but keeps the archive. */}
        <Show when={view()} keyed>
          {(current) => (
            <div inert={nav.front()} {...stylex.attrs(styles.tool, nav.front() && styles.gone)}>
              <Workspace
                view={current}
                layout={layout()}
                nav={nav}
                onSort={onSort}
                onPick={() => void pick()}
              />
            </div>
          )}
        </Show>
      </main>
      <StatusBar
        archive={session()?.info}
        idle={
          sampleUse() !== undefined
            ? front.making
            : sampleFailed()
              ? front.sampleFailed
              : online()
                ? ""
                : preloaded()
                  ? front.offline
                  : front.offlineOnly
        }
        offline={!online() && sampleUse() === undefined && !sampleFailed()}
        rows={view()?.rows() ?? 0}
        declared={view()?.declared()}
        storeBytes={view()?.storeBytes() ?? 0}
        budgetBytes={view()?.session.budget ?? SOFT_BUDGET_BYTES}
        phase={view()?.phase() ?? OPENING}
        onCancel={() => active?.cancel()}
        narrow={narrow()}
        onUpdate={update() === undefined ? undefined : reloadForUpdate}
      />
      <Show when={offered()}>
        {(file) => {
          const OpenChoice = choiceModule!.OpenChoice;
          return (
            <OpenChoice
              name={file().file.name}
              open={session()?.info.name ?? ""}
              writing={untrack(() => active?.writing() ?? false)}
              onReplace={() => {
                setOffered(undefined);
                open(file());
              }}
              onNewTab={() => openInNewTab(file())}
              onCancel={() => setOffered(undefined)}
            />
          );
        }}
      </Show>
      <span id="cross-origin-isolated" hidden>
        {String(isolated)}
      </span>
    </div>
  );
}

const styles = stylex.create({
  app: {
    // Native controls (check boxes, progress) take the action color.
    accentColor: color.water,
    backgroundColor: color.ground,
    color: color.ink,
    display: "grid",
    fontFamily: font.ui,
    fontSize: textSize.body,
    fontVariantNumeric: "tabular-nums",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: `${size.top} minmax(0, 1fr) ${size.status}`,
    height: "100dvh",
    lineHeight: 1.4,
    overflow: "hidden",
    WebkitFontSmoothing: "antialiased",
  },
  main: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    minHeight: 0,
    minWidth: 0,
  },
  tool: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    minHeight: 0,
    minWidth: 0,
  },
  gone: {
    display: "none",
  },
});
