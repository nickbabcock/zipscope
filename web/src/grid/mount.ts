// Mounts a row pool in its view: the frame part, the resize observer, and
// the scroll and wheel listeners. The tree and the table use it.
import type { FrameLoop, Render } from "./frame";
import type { PoolRow, RowPool } from "./row-pool";

export interface MountOptions<R extends PoolRow> {
  pool: RowPool<R>;
  viewport: HTMLElement;
  loop: FrameLoop;
  /** Reads and writes the rows on each frame. */
  render: Render;
  /** The row count of the last frame. The wheel uses it. */
  rowCount: () => number;
  /** More elements whose size changes the rows, other than the viewport. */
  observe?: readonly Element[];
  /** Called on a resize, after the pool got its new size. */
  onResize?: () => void;
}

/**
 * Adds the pool to the frame loop and starts its listeners. Call it in
 * `onSettled`, after the first `pool.resize()`, and return the function
 * that it returns: it removes all of them.
 */
export function mountRowPool<R extends PoolRow>(options: MountOptions<R>): () => void {
  const { pool, viewport, loop } = options;
  const schedule = () => loop.schedule();
  const onWheel = (event: WheelEvent) => {
    if (pool.wheel(event, options.rowCount())) {
      event.preventDefault();
      schedule();
    }
  };
  const remove = loop.add({ render: options.render });
  // `pool.resize` hides all rows. The resize observer of the loop runs
  // before the paint and draws the frame then, one time for all pools: a
  // frame on the next animation frame would leave one painted frame with
  // no rows (the table and its block of the largest files would blink).
  const unobserve = loop.observeResize([viewport, ...(options.observe ?? [])], () => {
    pool.resize();
    options.onResize?.();
  });
  viewport.addEventListener("scroll", schedule, { passive: true });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    remove();
    unobserve();
    viewport.removeEventListener("scroll", schedule);
    viewport.removeEventListener("wheel", onWheel);
  };
}
