// The history model. Each history
// entry holds one `NavState` in `history.state`. The address bar always
// shows `/`. This file has no Solid code, so the unit tests use a fake
// history.
//
// Push: open an archive, enter a folder, go up, open the Archive panel,
// show in tree, open the preview in the narrow layout.
// Replace: move the selection, scroll, sort, change the columns, type a
// search query.
import type { TableSort } from "../view/sort";

export type Panel = "archive";

/** The value in `history.state` of each entry of the app. */
export interface NavState {
  /** Marks a state of this app. Other values in `history.state` are not
   *  states of this app. */
  zipscope: 1;
  /** The place of the entry in the history of the tab. Only the
   *  difference between two values has a meaning. */
  index: number;
  /** The id of the archive session of the entry, or "" for the front
   *  door. After a reload or a new file, old entries have an id that no
   *  open session has. */
  session: string;
  /** The file name of the archive of the session, or null for the front
   *  door. After a reload, the front door offers to open it again. */
  name: string | null;
  /** True when the archive of the session is the demo archive. */
  demo: boolean;
  /** The folder that the table lists, or null for the landing folder: the
   *  end of the root chain, which the worker selects. */
  folder: number | null;
  /** The folder names of the listed folder from the root, joined with
   *  `/`, or null for the root. After a reload, the front door shows it.
   *  The folder number is only valid in the same archive. */
  path: string | null;
  /** The search query. */
  query: string;
  /** The panel in the preview pane, or null for the entry preview. */
  panel: Panel | null;
  /** True when the preview pane is open. */
  preview: boolean;
  /** True when this entry was pushed to open the preview (narrow layout).
   *  Closing the preview then goes back one entry. */
  previewPushed: boolean;
  /** The full name of the entry in the preview, or null. */
  entry: string | null;
  /** The store row of the entry in the preview, or null. Names can repeat
   *  in an archive; the row tells which entry it is. */
  row: number | null;
  /** Back does not restore the sort, the columns or the scroll position:
   *  they are view settings. The reload restore uses the sort. */
  sort: TableSort | null;
  columns: string[] | null;
  scroll: number;
}

/** The parts of `window.history` that the navigator uses. */
export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string): void;
  replaceState(data: unknown, unused: string, url?: string): void;
  go(delta: number): void;
}

/** Timer functions, so the tests can control time. */
export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

/**
 * The shortest time between two `replaceState` calls, in milliseconds.
 * Browsers limit the calls (Safari throws after 100 calls in 10 s), and
 * scrolling and typing can change the state on each frame.
 */
export const REPLACE_INTERVAL = 250;

/** The address bar always shows this URL. */
const URL = "/";

export function frontState(index = 0): NavState {
  return {
    zipscope: 1,
    index,
    session: "",
    name: null,
    demo: false,
    folder: null,
    path: null,
    query: "",
    panel: null,
    preview: false,
    previewPushed: false,
    entry: null,
    row: null,
    sort: null,
    columns: null,
    scroll: 0,
  };
}

/** Returns the value as a state of this app, or undefined. */
export function readState(value: unknown): NavState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const state = value as Partial<NavState>;
  if (
    state.zipscope !== 1 ||
    typeof state.index !== "number" ||
    typeof state.session !== "string" ||
    typeof state.query !== "string"
  ) {
    return undefined;
  }
  return { ...frontState(), ...state };
}

/** The part of a state that a push or a replace changes. */
export type NavPatch = Partial<Omit<NavState, "zipscope" | "index">>;

/**
 * Keeps `history.state` and the current state together. A replace changes
 * the current state at once and writes it to the history entry at most
 * one time in `REPLACE_INTERVAL`. A push or a Back first writes or drops
 * the replace that waits, so it never goes to the wrong entry.
 */
export class Navigator {
  private current: NavState;
  private pending: unknown;
  private lastWrite = Number.NEGATIVE_INFINITY;
  /** The entry where the open session starts, or undefined. */
  private root: { session: string; index: number } | undefined;

  constructor(
    private readonly history: HistoryLike,
    private readonly timers: Timers = browserTimers,
  ) {
    const state = readState(history.state);
    if (state === undefined) {
      // The first entry of the app is the front door.
      this.current = frontState();
      history.replaceState(this.current, "", URL);
    } else {
      this.current = state;
    }
  }

  /** The state of the current entry. */
  get state(): NavState {
    return this.current;
  }

  /** True when the current entry shows the open session. */
  showsSession(session: string): boolean {
    return session !== "" && this.current.session === session;
  }

  /** Pushes the first entry of a new session. */
  openSession(session: string, name: string | null = null, demo = false): NavState {
    const state = this.push({ ...frontState(), session, name, demo });
    this.root = { session, index: state.index };
    return state;
  }

  /** Adds an entry after the current one. Forward entries go. */
  push(patch: NavPatch): NavState {
    this.flush();
    this.current = { ...this.current, ...patch, index: this.current.index + 1 };
    this.history.pushState(this.current, "", URL);
    this.lastWrite = this.timers.now();
    return this.current;
  }

  /** Changes the current entry. */
  replace(patch: NavPatch): NavState {
    this.current = { ...this.current, ...patch };
    if (this.pending === undefined) {
      const wait = this.lastWrite + REPLACE_INTERVAL - this.timers.now();
      if (wait <= 0) {
        this.write();
      } else {
        this.pending = this.timers.set(() => this.write(), wait);
      }
    }
    return this.current;
  }

  /** Writes a replace that waits. Call it before the page hides. */
  flush(): void {
    if (this.pending !== undefined) {
      this.write();
    }
  }

  /**
   * Takes the state of a `popstate` event. Returns the new current state,
   * or undefined when the entry is not one of this app. A replace that
   * waits is for the entry that was left. It is too late to write it, so
   * it goes.
   */
  pop(value: unknown): NavState | undefined {
    this.drop();
    const state = readState(value);
    if (state !== undefined) {
      this.current = state;
    }
    return state;
  }

  /** Goes back one entry. */
  back(): void {
    this.flush();
    this.history.go(-1);
  }

  /**
   * Goes to the first entry of the open session ("Return to <name>" on the
   * front door). Returns false when no entry of the session is known.
   */
  returnToSession(): boolean {
    if (this.root === undefined) {
      return false;
    }
    const delta = this.root.index - this.current.index;
    if (delta !== 0) {
      this.flush();
      this.history.go(delta);
    }
    return true;
  }

  /** Forgets the open session, for example when its file closes. */
  closeSession(): void {
    this.root = undefined;
  }

  private write(): void {
    this.drop();
    this.history.replaceState(this.current, "", URL);
    this.lastWrite = this.timers.now();
  }

  private drop(): void {
    if (this.pending !== undefined) {
      this.timers.clear(this.pending);
      this.pending = undefined;
    }
  }
}
