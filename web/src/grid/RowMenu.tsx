// The row actions: a menu on the Popover API, placed with CSS anchor
// positioning at the pointer or at the selected row. Right-click, the
// context-menu key and Shift+F10 open it. Each item has a one-key
// shortcut. The popover is manual: in some browsers, the release of the
// right button that opened an auto popover closes it again. The menu
// closes on a press outside it, Escape and Tab.
import * as stylex from "@stylexjs/stylex";
import { createSignal, flush, Show } from "solid-js";
import { STOPPED } from "../health/findings";
import { controls } from "../shell/controls";
import { color, textSize } from "../theme/tokens.stylex";
import { ANCHORS } from "./anchors";

/** The values that the menu has for all rows. */
interface MenuRow {
  /** The full path. A folder path ends with `/`. */
  path: string;
  /** The row as tab-separated values, for a spreadsheet. */
  tsv: string;
  /** True when the row is a search result. */
  search: boolean;
}

/** The row that the menu acts on: an entry with its store row, or a
 *  folder. */
export type MenuTarget =
  | (MenuRow & { kind: "entry"; row: number })
  | (MenuRow & { kind: "folder" });

/** A rectangle in viewport pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RowMenuApi {
  /** Opens the menu. With `pointer`, no item is active. */
  open(target: MenuTarget, at: Rect, pointer: boolean): void;
}

export interface RowMenuProps {
  api: (api: RowMenuApi) => void;
  /** True after the hard stop. Then the worker refuses each folder
   *  change, so "Show in tree" is off. */
  foldersStopped: boolean;
  onPreview: (target: MenuTarget) => void;
  onShowInTree: (target: MenuTarget) => void;
  /** Extracts an entry or a folder. */
  onExtract: (target: MenuTarget) => void;
  /** The menu closed while it had the focus. */
  onClose: () => void;
}

interface Item {
  id: string;
  label: string;
  key: string;
  /** Returns undefined when the item can run, or the reason when not. */
  blocked: (target: MenuTarget, props: RowMenuProps) => string | undefined;
  shown: (target: MenuTarget) => boolean;
  run: (target: MenuTarget, props: RowMenuProps) => void;
}

const copy = (text: string) => {
  navigator.clipboard?.writeText(text).catch(() => {});
};

const ITEMS: Item[] = [
  {
    id: "preview",
    label: "Preview",
    key: "P",
    blocked: (target) => (target.kind === "folder" ? "Folders have no preview" : undefined),
    shown: () => true,
    run: (target, props) => props.onPreview(target),
  },
  {
    id: "extract",
    label: "Extract",
    key: "E",
    blocked: () => undefined,
    shown: () => true,
    run: (target, props) => props.onExtract(target),
  },
  {
    id: "copy-path",
    label: "Copy path",
    key: "C",
    blocked: () => undefined,
    shown: () => true,
    run: (target) => copy(target.path),
  },
  {
    id: "copy-row",
    label: "Copy row",
    key: "R",
    blocked: () => undefined,
    shown: () => true,
    run: (target) => copy(target.tsv),
  },
  {
    id: "show-in-tree",
    label: "Show in tree",
    key: "T",
    // It lists the folder of the entry, which the hard stop refuses.
    blocked: (_target, props) => (props.foldersStopped ? STOPPED.folders : undefined),
    shown: (target) => target.search && target.kind === "entry",
    run: (target, props) => props.onShowInTree(target),
  },
];

export function RowMenu(props: RowMenuProps) {
  let menu!: HTMLDivElement;
  let anchor!: HTMLSpanElement;
  const [target, setTarget] = createSignal<MenuTarget>();

  const items = () => menu.querySelectorAll<HTMLElement>("[role=menuitem]");
  // Disabled items take the focus too, so that their reason is read.
  const shownItems = () => [...items()].filter((item) => !item.hidden);
  const move = (step: number) => {
    const list = shownItems();
    const at = list.indexOf(document.activeElement as HTMLElement);
    // With no active item (after a pointer open), Up goes to the last item.
    // The first item that can run is the start, not an item that is off.
    const start = Math.max(
      0,
      list.findIndex((item) => !item.hasAttribute("aria-disabled")),
    );
    const next = step === 0 ? start : at < 0 && step < 0 ? -1 : at + step;
    list[step === Infinity ? list.length - 1 : (next + list.length) % list.length]?.focus();
  };

  /** Closes the menu. When the menu has the focus, the focus goes back at
   *  once. A manual popover does not move the focus when it hides, and the
   *  toggle event comes in a later task: a key that the user presses
   *  before that task goes to the hidden item. */
  const close = () => {
    const inside = menu.contains(document.activeElement);
    menu.hidePopover();
    if (inside) props.onClose();
  };

  const run = (item: Item) => {
    const current = target();
    if (current === undefined || item.blocked(current, props) !== undefined) {
      return;
    }
    close();
    item.run(current, props);
  };

  const onOutside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) {
      menu.hidePopover();
    }
  };

  props.api({
    open(next, at, pointer) {
      setTarget(next);
      // Show the items of this target before the menu takes the focus.
      flush();
      Object.assign(anchor.style, {
        left: `${at.x}px`,
        top: `${at.y}px`,
        width: `${at.width}px`,
        height: `${at.height}px`,
      });
      if (menu.matches(":popover-open")) {
        menu.hidePopover();
      }
      menu.showPopover();
      if (!ANCHORS) {
        // Below the anchor, or above it when there is no room below.
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const below = at.y + at.height;
        menu.style.left = `${Math.max(8, Math.min(at.x, innerWidth - width - 8))}px`;
        menu.style.top = `${below + height > innerHeight - 8 ? Math.max(8, at.y - height) : below}px`;
      }
      // Only the keyboard makes the first item active: a pointer points at the
      // item it wants, so the menu itself takes the focus for the keys.
      if (pointer) menu.focus();
      else move(0);
    },
  });

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(Infinity);
        break;
      case "Tab":
        menu.hidePopover();
        return;
      case "Escape":
        close();
        break;
      default: {
        const current = target();
        const item = ITEMS.find(
          (each) =>
            each.key.toLowerCase() === event.key.toLowerCase() &&
            current !== undefined &&
            each.shown(current),
        );
        if (item === undefined || event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }
        run(item);
      }
    }
    event.preventDefault();
  };

  const onToggle = (event: ToggleEvent) => {
    if (event.newState === "open") {
      document.addEventListener("pointerdown", onOutside, true);
      return;
    }
    document.removeEventListener("pointerdown", onOutside, true);
    const active = document.activeElement;
    if (active === null || active === document.body || menu.contains(active)) {
      props.onClose();
    }
  };

  return (
    <>
      <span
        ref={(el) => (anchor = el)}
        id="row-menu-anchor"
        aria-hidden="true"
        {...stylex.attrs(styles.anchor)}
      />
      <div
        ref={(el) => (menu = el)}
        id="row-menu"
        role="menu"
        aria-label="Row actions"
        popover="manual"
        tabindex={-1}
        data-anchored={ANCHORS ? "true" : "false"}
        onKeyDown={onKeyDown}
        onToggle={onToggle}
        {...stylex.attrs(styles.menu, ANCHORS && styles.anchored, controls.fadeIn)}
      >
        {ITEMS.map((item) => {
          const reason = () => {
            const current = target();
            return current === undefined ? undefined : item.blocked(current, props);
          };
          const shown = () => {
            const current = target();
            return current !== undefined && item.shown(current);
          };
          return (
            <>
              <Show when={item.id === "copy-path"}>
                <hr {...stylex.attrs(styles.rule)} />
              </Show>
              <button
                type="button"
                role="menuitem"
                tabindex={-1}
                hidden={!shown()}
                data-action={item.id}
                aria-disabled={reason() === undefined ? undefined : "true"}
                aria-keyshortcuts={item.key}
                aria-describedby={reason() === undefined ? undefined : `${item.id}-reason`}
                onClick={() => run(item)}
                {...stylex.attrs(styles.item, reason() !== undefined && styles.disabled)}
              >
                <span {...stylex.attrs(styles.text)}>
                  {item.label}
                  <span
                    id={`${item.id}-reason`}
                    hidden={reason() === undefined}
                    {...stylex.attrs(styles.reason)}
                  >
                    {reason() ?? ""}
                  </span>
                </span>
                <kbd aria-hidden="true" {...stylex.attrs(controls.keyPlain, styles.keyHint)}>
                  {item.key}
                </kbd>
              </button>
            </>
          );
        })}
      </div>
    </>
  );
}

const COARSE = "@media (pointer: coarse)";

const styles = stylex.create({
  /** The menu opens at this anchor: the pointer or the selected row. */
  anchor: {
    anchorName: "--row-menu",
    pointerEvents: "none",
    position: "fixed",
  },
  /** Below the anchor. When there is no room, the menu flips. */
  anchored: {
    positionAnchor: "--row-menu",
    positionArea: "block-end span-inline-end",
    positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
  },
  menu: {
    outlineStyle: "none",
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
    // As wide as its items, with 16 px before the key column.
    minWidth: 160,
    padding: 4,
    position: "fixed",
    width: "max-content",
  },
  item: {
    alignItems: "center",
    backgroundColor: {
      default: "transparent",
      ":hover": color.raised,
      ":focus-visible": color.selectBg,
      ":focus": color.selectBg,
    },
    borderRadius: 4,
    borderStyle: "none",
    color: "inherit",
    columnGap: 16,
    cursor: "pointer",
    display: "flex",
    font: "inherit",
    justifyContent: "space-between",
    // A touch screen gets 40 px items.
    minHeight: { default: 28, [COARSE]: 40 },
    // The fill and a 1 px water ring show the active item, because the fill
    // alone is 1.2:1. A ring follows the corner of the tile, which a bar at
    // one edge does not. The focus ring also shows when the keyboard moves
    // the focus.
    boxShadow: { default: null, ":focus": `inset 0 0 0 1px ${color.water}` },
    outlineColor: color.focus,
    outlineOffset: -2,
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    paddingInline: 8,
    textAlign: "start",
    width: "100%",
  },
  /** A fixed column, so the hints are one column at the end of the items. A
   *  touch screen has no keys to press: no key hints. */
  keyHint: {
    display: { default: null, [COARSE]: "none" },
    flexShrink: 0,
    textAlign: "center",
    width: 12,
  },
  disabled: {
    color: color.inkMuted,
    cursor: "default",
  },
  /** The verbs, then the copies. */
  rule: {
    backgroundColor: color.overlayRule,
    borderStyle: "none",
    height: 1,
    marginBlock: 4,
    marginInline: 0,
  },
  /** A line height in whole pixels, so an item is 28 px high. */
  text: {
    display: "flex",
    flexDirection: "column",
    lineHeight: "20px",
    paddingBlock: 4,
  },
  reason: {
    fontSize: textSize.label,
  },
});
