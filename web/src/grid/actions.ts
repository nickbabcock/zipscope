// The navigation that the grid keys and the row menu start: Enter on a
// folder, Backspace, and "show in tree". This file is the one seam to the
// navigation module (nav/navigation.ts), which owns the history rules:
// these actions push a history entry.
import { NONE } from "../contracts";
import type { Navigation } from "../nav/navigation";
import type { MirrorReader } from "../store/reader";

export interface GridActions {
  /** Goes into a folder: Enter or a click on a folder row. */
  navigateToFolder(folder: number): void;
  /** Goes up one level: Backspace. */
  goUp(): void;
  /** Ends the search and lists the folder of an entry. */
  showInTree(folder: number, name?: string, row?: number): void;
}

export interface GridActionDeps {
  reader: MirrorReader;
  nav: Pick<Navigation, "navigateToFolder" | "goUp" | "showInTree" | "query">;
}

export function createGridActions(deps: GridActionDeps): GridActions {
  const { reader, nav } = deps;
  return {
    navigateToFolder: (folder) => nav.navigateToFolder(folder),
    goUp() {
      // In search results, Backspace leaves the search to its folder.
      if (nav.query() !== "") {
        nav.goUp();
        return;
      }
      // The parent folder, also inside a compact chain: from `a/b/c/`,
      // Backspace lists `a/b/`.
      const views = reader.views();
      if (views === undefined || views.folder === NONE || views.folder === 0) {
        return;
      }
      const parent = reader.folderParent(views.folder);
      if (parent !== NONE) {
        nav.navigateToFolder(parent);
      }
    },
    showInTree: (folder, name, row) => nav.showInTree(folder, name, row),
  };
}
