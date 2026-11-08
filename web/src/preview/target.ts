// The entry that the preview shows, and the check that its row is listed.
import { createMemo } from "solid-js";

/** The entry that the preview shows. */
export interface PreviewTarget {
  row: number;
  name: string;
}

/**
 * Returns an accessor for the target while its row is listed, else
 * undefined. It tracks the target and the count of listed rows. Thus a
 * target whose row is not listed yet shows when the row arrives. The value
 * changes only when the row or the name changes.
 */
export function listedTarget(
  target: () => PreviewTarget | undefined,
  rows: () => number,
): () => PreviewTarget | undefined {
  return createMemo(
    () => {
      const next = target();
      return next !== undefined && next.row < rows() ? next : undefined;
    },
    { equals: (a, b) => a?.row === b?.row && a?.name === b?.name },
  );
}
