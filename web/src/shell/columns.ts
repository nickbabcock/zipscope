// The columns of the table that hide: the ones that the user chose to
// hide, and more when the table has no room for them.
import { createMemo, createSignal } from "solid-js";
import {
  BAR,
  fitColumns,
  HIDDEN_WHEN_NARROW,
  HIDDEN_WITH_PREVIEW,
  tableMinWidth,
  toggleColumn,
} from "../grid/columns";
import type { ColumnKey, HiddenColumns } from "../grid/columns";

/** True when two column sets have the same keys. */
export function sameColumns(a: HiddenColumns, b: HiddenColumns): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

export interface ColumnOptions {
  narrow: () => boolean;
  previewOpen: () => boolean;
  /** The width for the table, or undefined before the first measure. */
  room: () => number | undefined;
  /** Called with the columns that the user chose to hide now. */
  onPick?: (hidden: HiddenColumns) => void;
}

/**
 * Makes the column state of the table. The preview has its own choice:
 * while it is open, the table has less room. `hidden` and `blocked` are
 * memos with a set comparison, so a resize that does not change a set
 * does not run their readers again.
 */
export function createColumns(options: ColumnOptions) {
  // The column choices while the preview is closed and while it is open.
  const [hiddenClosed, setHiddenClosed] = createSignal<HiddenColumns>(new Set());
  const [hiddenOpen, setHiddenOpen] = createSignal<HiddenColumns>(HIDDEN_WITH_PREVIEW);

  /** The columns that the user chose to hide. */
  const chosen = () =>
    options.narrow() ? HIDDEN_WHEN_NARROW : options.previewOpen() ? hiddenOpen() : hiddenClosed();
  /** The columns that hide: the chosen ones, and more when the table has
   *  no room for them. */
  const hidden = createMemo(
    () => {
      const room = options.room();
      return room === undefined ? chosen() : fitColumns(chosen(), room);
    },
    { equals: sameColumns },
  );
  /** Hidden columns that have no room to show. */
  const blocked = createMemo(
    () => {
      const now = hidden();
      const room = options.room() ?? Infinity;
      // The bar and Entries leave before a column that the user chose.
      return new Set(
        [...now].filter(
          (key) =>
            key !== BAR &&
            key !== "entries" &&
            tableMinWidth(new Set([...toggleColumn(now, key, true), BAR, "entries"])) > room,
        ),
      );
    },
    { equals: sameColumns },
  );
  /** Shows or hides a column that the user chose. */
  const pick = (key: ColumnKey, show: boolean) => {
    const [current, set] = options.previewOpen()
      ? [hiddenOpen(), setHiddenOpen]
      : [hiddenClosed(), setHiddenClosed];
    const next = toggleColumn(current, key, show);
    set(next);
    options.onPick?.(next);
  };
  return { hidden, blocked, pick };
}
