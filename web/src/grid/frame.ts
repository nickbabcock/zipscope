// One animation frame of the archive views. It reads the header one time,
// so the status and the decision to schedule the next frame use the same
// snapshot. The tree and the table render from one set of the views, under
// the generation seqlock: each part first reads its values, the frame
// checks the generation, and only then do the parts change the DOM.
import { State } from "../contracts";
import type { ViewSet } from "../store/reader";

export interface FrameSource {
  state(): State;
  committedRows(): number;
  visibleRows(): number;
  visibleFolders(): number;
  views(): ViewSet | undefined;
  stable(set: ViewSet): boolean;
  /** True when the header arrived. Without it, no views come. */
  opened(): boolean;
}

export interface FrameSnapshot {
  state: State;
  committed: number;
  visible: number;
}

/** What one render of the views reads. */
export interface Frame extends FrameSnapshot {
  /** Folders that are safe to read. */
  folders: number;
  /** The active view set, or undefined before the first set arrives. */
  views: ViewSet | undefined;
  /** True while rolled-up values can still grow. */
  settling: boolean;
}

/** The values that a part read for one frame. */
export interface Prepared {
  /** False when a row could not show yet. */
  complete: boolean;
  /** Writes the values to the DOM. Call it only for a stable set. */
  commit(): void;
}

/** Reads the values of a frame. It must not change the DOM. */
export type Render = (frame: Frame) => Prepared;

/** Reads one set at most this many times in one frame when the worker
 *  publishes during the read. */
const ATTEMPTS = 3;

const TERMINAL: readonly State[] = [State.COMPLETE, State.CANCELLED, State.FAILED];

/** Draws one frame. Returns true when the loop must draw the next frame. */
export function drawFrame(
  source: FrameSource,
  render: Render,
  report: (snapshot: FrameSnapshot) => void,
): boolean {
  // Read the state first. The worker stores STATE after the last count, so
  // a terminal state here means that `committed` is final.
  const state = source.state();
  const committed = source.committedRows();
  let visible = 0;
  let complete = false;
  let stable = false;
  // The seqlock: read, then check that the set did not change. Only a
  // stable read goes to the DOM. When all reads change, the screen keeps
  // the last stable frame and the next frame reads again.
  for (let attempt = 0; attempt < ATTEMPTS && !stable; attempt++) {
    const views = source.views();
    visible = Math.min(source.visibleRows(), committed);
    const frame: Frame = {
      state,
      committed,
      visible,
      folders: source.visibleFolders(),
      views,
      // Values of a partial listing (cancelled or failed) are lower bounds.
      settling: state !== State.COMPLETE,
    };
    const prepared = render(frame);
    stable = views === undefined || source.stable(views);
    if (stable) {
      prepared.commit();
      complete = prepared.complete;
    }
  }
  // When the open failed, no views come. Nothing is left to draw.
  if (!source.opened() && TERMINAL.includes(state)) {
    complete = true;
  }
  report({ state, committed, visible });
  return (
    state === State.OPENING ||
    state === State.PARSING ||
    visible < committed ||
    !stable ||
    !complete
  );
}

/** A part of the page that renders on each frame. */
export interface FramePart {
  render: Render;
}

/** Runs one animation-frame loop for all parts. It stops when nothing can
 *  change, and starts again with `schedule`. */
export class FrameLoop {
  private readonly parts = new Set<FramePart>();
  private frame = 0;
  /** One resize observer for all parts, so a frame where many elements
   *  change size draws one time. */
  private observer: ResizeObserver | undefined;
  private readonly sized = new Map<Element, Set<() => void>>();

  constructor(
    private readonly source: FrameSource,
    private readonly report: (snapshot: FrameSnapshot) => void,
  ) {}

  /** Adds a part and draws a frame. Returns a function that removes it. */
  add(part: FramePart): () => void {
    this.parts.add(part);
    this.schedule();
    return () => this.parts.delete(part);
  }

  /** Draws a frame soon, if no frame is waiting. */
  schedule(): void {
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(this.draw);
    }
  }

  /**
   * Calls `onResize` when one of `elements` changes size. The loop has one
   * resize observer: its callback calls each handler of the elements that
   * changed one time, and then draws one frame now. It runs after the
   * layout and before the paint, so rows that a handler hid show again in
   * the same frame. Returns the function that stops the observation.
   */
  observeResize(elements: readonly Element[], onResize: () => void): () => void {
    const observer = (this.observer ??= new ResizeObserver((entries) => {
      const handlers = new Set<() => void>();
      for (const entry of entries) {
        for (const handler of this.sized.get(entry.target) ?? []) handlers.add(handler);
      }
      for (const handler of handlers) handler();
      this.drawNow();
    }));
    for (const element of elements) {
      let handlers = this.sized.get(element);
      if (handlers === undefined) {
        handlers = new Set();
        this.sized.set(element, handlers);
        observer.observe(element);
      }
      handlers.add(onResize);
    }
    return () => {
      for (const element of elements) {
        const handlers = this.sized.get(element);
        handlers?.delete(onResize);
        if (handlers?.size === 0) {
          this.sized.delete(element);
          observer.unobserve(element);
        }
      }
    };
  }

  /** Draws a frame now, in place of the frame that waits. */
  drawNow(): void {
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
    }
    this.draw();
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly draw = () => {
    this.frame = 0;
    const render = (frame: Frame): Prepared => {
      const prepared = [...this.parts].map((part) => part.render(frame));
      return {
        complete: prepared.every((part) => part.complete),
        commit: () => {
          for (const part of prepared) {
            part.commit();
          }
        },
      };
    };
    if (drawFrame(this.source, render, this.report)) {
      this.schedule();
    }
  };
}
