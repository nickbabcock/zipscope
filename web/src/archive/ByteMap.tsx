// The byte map of the Archive panel: a bar with one part for each region,
// in file order and sized by bytes, and the list of regions with their
// offsets and sizes. The prelude, the gaps and the epilogue can show in
// hex and be saved. Their bytes come straight from the file: they are a
// part of the file, not entry data, so no decoder runs. When the file
// has no prelude, gap, epilogue or overlap, one sentence replaces the bar
// and the list.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { RegionKind } from "../contracts";
import type { ArchiveRegion, LayoutCounts } from "../contracts";
import { exactBytes, formatSize, integers } from "../format";
import { saveBlob } from "../preview/extract";
import { hexDump } from "../preview/sniff";
import { controls } from "../shell/controls";
import { Icon } from "../shell/icons";
import { color, font, size, textSize } from "../theme/tokens.stylex";
import {
  hexOffset,
  layoutNotes,
  layoutSummary,
  panel,
  regionFileName,
  regionName,
  regionNote,
  plainLayout,
  regionRange,
  unaccounted,
  unusualLayout,
} from "./strings";

/** The hex view shows this much at first, and this much more each time. */
const HEX_FIRST = 4 * 1024;
const HEX_STEP = 64 * 1024;
/** The most bytes that the hex view shows. Save the region for more. */
const HEX_MAX = 256 * 1024;
/** With more regions, small regions get no minimum width in the bar. */
const BAR_MIN_REGIONS = 64;
/** The width of the panel below which the small tables have narrow columns. */
const NARROW_PANEL = "@container (width < 420px)";

/** The bar color of each kind. Entry data is neutral; the bytes that no
 *  part of the archive accounts for use the contour color. */
const tones = {
  [RegionKind.PRELUDE]: "loose",
  [RegionKind.ENTRIES]: "entries",
  [RegionKind.GAP]: "loose",
  [RegionKind.DIRECTORY]: "directory",
  [RegionKind.ZIP64_RECORD]: "records",
  [RegionKind.ZIP64_LOCATOR]: "records",
  [RegionKind.END_RECORD]: "records",
  [RegionKind.EPILOGUE]: "loose",
} as const;

const kindIds: Record<RegionKind, string> = {
  [RegionKind.PRELUDE]: "prelude",
  [RegionKind.ENTRIES]: "entries",
  [RegionKind.GAP]: "gap",
  [RegionKind.DIRECTORY]: "directory",
  [RegionKind.ZIP64_RECORD]: "zip64-record",
  [RegionKind.ZIP64_LOCATOR]: "zip64-locator",
  [RegionKind.END_RECORD]: "end-record",
  [RegionKind.EPILOGUE]: "epilogue",
};

/** The `data-kind` value of a region, for the DOM and the tests. */
export function kindId(kind: RegionKind): string {
  return kindIds[kind] ?? String(kind);
}

export interface ByteMapProps {
  file: Blob;
  archiveName: string;
  regions: ArchiveRegion[];
  counts: LayoutCounts;
  /** True when the listing is partial. */
  partial: boolean;
  /** True when the health list has a finding of an overlap. */
  overlapFinding: boolean;
}

export function ByteMap(props: ByteMapProps) {
  const size = () => props.file.size;
  const unusual = () => unusualLayout(props.regions, props.counts);
  return (
    <div {...stylex.attrs(styles.root)}>
      <Show
        when={unusual()}
        fallback={
          <p id="byte-map-plain" {...stylex.attrs(styles.text)}>
            {plainLayout(size(), props.overlapFinding)}
          </p>
        }
      >
        <ByteBar regions={props.regions} size={size()} />
        {/* The chips of the region table are the legend of the bar. */}
        <p id="byte-map-summary" {...stylex.attrs(styles.text)}>
          {layoutSummary(size(), props.counts)}
        </p>
      </Show>
      <For each={layoutNotes(props.counts, props.partial)}>
        {(note) => <p {...stylex.attrs(styles.text, styles.note)}>{note}</p>}
      </For>
      <Show when={unusual()}>
        <RegionTable regions={props.regions} file={props.file} archiveName={props.archiveName} />
      </Show>
    </div>
  );
}

/** The bar: one part for each region, in file order and sized by bytes. */
function ByteBar(props: { regions: ArchiveRegion[]; size: number }) {
  /** The part of the file in a region, for the flex grow of its part. */
  const share = (region: ArchiveRegion) =>
    props.size > 0 ? (((region.end - region.start) / props.size) * 1e6).toFixed(3) : "0";
  return (
    <div
      id="byte-map-bar"
      role="img"
      aria-label={`Byte map: ${integers.format(props.regions.length)} regions`}
      {...stylex.attrs(styles.bar)}
    >
      <For each={props.regions}>
        {(region) => (
          <span
            data-kind={kindId(region.kind)}
            title={`${regionName(region)}: ${hexOffset(region.start)}, ${formatSize(region.end - region.start)}`}
            style={{ "flex-grow": share(region) }}
            {...stylex.attrs(
              styles.part,
              styles[tones[region.kind]],
              props.regions.length <= BAR_MIN_REGIONS && styles.visible,
            )}
          />
        )}
      </For>
    </div>
  );
}

/** One column grid for the small tables of the panel, so a Size column ends at
 *  one x in all of them. */
export function TableColumns() {
  return (
    <colgroup>
      <col {...stylex.attrs(styles.columnName)} />
      <col {...stylex.attrs(styles.columnFirst)} />
      <col {...stylex.attrs(styles.columnNumber)} />
      <col {...stylex.attrs(styles.columnLast)} />
    </colgroup>
  );
}

/** The list of the regions with their offsets and sizes. */
function RegionTable(props: { regions: ArchiveRegion[]; file: Blob; archiveName: string }) {
  return (
    <table id="byte-map-regions" {...stylex.attrs(styles.table)}>
      <TableColumns />
      <thead>
        <tr>
          <th scope="col" colspan="2" {...stylex.attrs(styles.head)}>
            Region
          </th>
          <th scope="col" {...stylex.attrs(styles.head, styles.number)}>
            Size
          </th>
          <th scope="col" {...stylex.attrs(styles.head, styles.number)}>
            Offset
          </th>
        </tr>
      </thead>
      <For each={props.regions}>
        {(region, index) => (
          <RegionRow
            region={region}
            index={index()}
            file={props.file}
            archiveName={props.archiveName}
          />
        )}
      </For>
    </table>
  );
}

function RegionRow(props: {
  region: ArchiveRegion;
  index: number;
  file: Blob;
  archiveName: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const bytes = () => props.region.end - props.region.start;
  /** The buttons name the region, so they cannot belong to another row. */
  const label = () => regionName(props.region).toLowerCase();
  const save = () => {
    const region = props.region;
    const range = regionRange(region, 0, region.end - region.start);
    saveBlob(props.file.slice(range.start, range.end), regionFileName(props.archiveName, region));
    setSaved(true);
  };
  return (
    <tbody
      id={`region-${props.index}`}
      data-kind={kindId(props.region.kind)}
      data-offset={props.region.start}
      data-size={bytes()}
      tabindex="-1"
      {...stylex.attrs(styles.group)}
    >
      <tr>
        <td colspan="2" {...stylex.attrs(styles.cell)}>
          <span {...stylex.attrs(styles.name)}>
            <span {...stylex.attrs(styles.chip, styles[tones[props.region.kind]])} />
            {regionName(props.region)}
          </span>
          <Show when={regionNote(props.region)}>
            {(note) => (
              <span data-part="note" {...stylex.attrs(styles.regionNote)}>
                {note()}
              </span>
            )}
          </Show>
        </td>
        <td title={exactBytes(bytes())} {...stylex.attrs(styles.cell, styles.number)}>
          {formatSize(bytes())}
        </td>
        <td
          title={exactBytes(props.region.start)}
          {...stylex.attrs(styles.cell, styles.number, styles.mono)}
        >
          {hexOffset(props.region.start)}
        </td>
      </tr>
      {/* The actions are one row on the gutter, below the region, at
          every width. */}
      <Show when={unaccounted(props.region.kind)}>
        <tr>
          <td colspan="4" {...stylex.attrs(styles.actionCell)}>
            <span {...stylex.attrs(styles.actions)}>
              <button
                type="button"
                data-action="hex"
                aria-expanded={open() ? "true" : "false"}
                aria-controls={`region-hex-${props.index}`}
                onClick={() => setOpen((value) => !value)}
                {...stylex.attrs(controls.button, controls.focusRing, styles.small)}
              >
                <Icon name="hex" />
                {open() ? panel.hideHex(label()) : panel.hex(label())}
              </button>
              <button
                type="button"
                data-action="save"
                title={`Save the ${formatSize(bytes())} of this region as a file`}
                onClick={save}
                {...stylex.attrs(controls.button, controls.focusRing, styles.small)}
              >
                <Icon name="download" />
                {saved() ? panel.saved(label()) : panel.save(label())}
              </button>
            </span>
          </td>
        </tr>
      </Show>
      <Show when={open()}>
        <tr>
          <td colspan="4" {...stylex.attrs(styles.hexCell)}>
            <RegionHex id={`region-hex-${props.index}`} file={props.file} region={props.region} />
          </td>
        </tr>
      </Show>
    </tbody>
  );
}

interface HexState {
  text: string;
  /** The bytes that the dump shows. */
  shown: number;
  busy: boolean;
  error?: string;
}

/** The first bytes of a region in hex, with the file offsets. "Load more"
 *  reads more, up to `HEX_MAX`. */
function RegionHex(props: { id: string; file: Blob; region: ArchiveRegion }) {
  const [state, setState] = createSignal<HexState>({ text: "", shown: 0, busy: true });
  let live = true;
  onCleanup(() => (live = false));
  const total = () => props.region.end - props.region.start;
  /** Reads the first `bytes` bytes. The first read starts with the view,
   *  which is already busy; a later read starts from a click. */
  const read = (bytes: number) => {
    const { start } = props.region;
    const range = regionRange(props.region, 0, Math.min(bytes, HEX_MAX));
    props.file
      .slice(range.start, range.end)
      .arrayBuffer()
      .then(
        (buffer) => {
          if (!live) return;
          const data = new Uint8Array(buffer);
          setState({ text: hexDump(data, start), shown: data.length, busy: false });
        },
        (err: unknown) => {
          if (!live) return;
          const error = err instanceof Error ? err.message : String(err);
          setState((last) => ({ ...last, busy: false, error }));
        },
      );
  };
  read(HEX_FIRST);
  const more = () => state().shown > 0 && state().shown < Math.min(total(), HEX_MAX);
  return (
    <div id={props.id} {...stylex.attrs(styles.hex)}>
      <Show when={state().error}>
        {(error) => <p {...stylex.attrs(styles.text, styles.crit)}>{error()}</p>}
      </Show>
      <Show
        when={state().shown > 0 || !state().busy}
        fallback={<p {...stylex.attrs(styles.text, styles.pending)}>{panel.reading}</p>}
      >
        <pre data-part="hex" {...stylex.attrs(styles.pre)}>
          {state().text}
        </pre>
      </Show>
      <div {...stylex.attrs(styles.hexFooter)}>
        <span>
          {state().shown >= total()
            ? `All ${formatSize(total())}`
            : `First ${formatSize(state().shown)} of ${formatSize(total())}`}
        </span>
        <Show when={more()}>
          <button
            type="button"
            data-action="more"
            disabled={state().busy}
            onClick={() => {
              setState((last) => ({ ...last, busy: true }));
              read(state().shown + HEX_STEP);
            }}
            {...stylex.attrs(styles.link, controls.focusRing, controls.touchArea)}
          >
            {panel.more}
          </button>
        </Show>
      </div>
    </div>
  );
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    rowGap: 8,
  },
  bar: {
    backgroundColor: color.barTrack,
    borderRadius: 2,
    columnGap: 1,
    display: "flex",
    height: 14,
    overflow: "hidden",
  },
  part: {
    flexBasis: 0,
    minWidth: 0,
  },
  /** Each region can be seen, also when it is only a few bytes of a large
   *  file. A 1 px gap of the track shows each boundary. */
  visible: {
    minWidth: 6,
  },
  // One ramp. Entry data: the size bar color
  // (stone-500), at least 3:1 against the panel in both themes: 4.8:1 on white
  // and 4.1:1 on the night ground. The central directory has the same color in
  // a hatch, so it does not need a second fill near the first. The records are
  // ink: at the size of a chip, ink muted is hard to tell from the entry data.
  entries: {
    backgroundColor: color.bar,
  },
  directory: {
    backgroundImage: `repeating-linear-gradient(135deg, ${color.bar} 0 2px, transparent 2px 4px)`,
  },
  records: {
    backgroundColor: color.ink,
  },
  // contour: amber-700, amber-600 (night).
  loose: {
    backgroundColor: color.contour,
  },
  /** A 1 px edge keeps a light chip visible on the panel. */
  chip: {
    borderRadius: 2,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color.ink} 25%, transparent)`,
    display: "inline-block",
    flexShrink: 0,
    height: 10,
    width: 10,
  },
  text: {
    fontSize: textSize.small,
    margin: 0,
  },
  note: {
    color: color.warn,
  },
  crit: {
    color: color.crit,
  },
  pending: {
    color: color.inkMuted,
    padding: size.gutter,
  },
  table: {
    borderCollapse: "collapse",
    fontSize: textSize.small,
    tableLayout: "fixed",
    width: "100%",
  },
  columnName: {
    width: { default: "34%", [NARROW_PANEL]: "28%" },
  },
  columnNumber: {
    width: "22%",
  },
  /** The first number column, Entries in a breakdown. */
  columnFirst: {
    width: { default: "22%", [NARROW_PANEL]: "16%" },
  },
  /** The last column: "COMPRESSED" or a hex offset fits at all widths. */
  columnLast: {
    width: { default: "22%", [NARROW_PANEL]: "34%" },
  },
  head: {
    color: color.inkMuted,
    fontSize: textSize.label,
    fontWeight: 400,
    letterSpacing: "0.04em",
    paddingBlock: 4,
    paddingInline: 0,
    textAlign: "left",
    textTransform: "uppercase",
  },
  /** A row of the small tables has no rule. */
  group: {
    outlineColor: color.focus,
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
  },
  /** The 24 px row of the small tables of the panel. */
  cell: {
    height: 24,
    paddingBlock: 0,
    paddingInline: 0,
    verticalAlign: "middle",
  },
  /** The actions are near their region and far from the next one. */
  actionCell: {
    paddingBlock: "8px 16px",
    paddingInline: 0,
  },
  number: {
    paddingInlineStart: 8,
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  mono: {
    fontFamily: font.mono,
  },
  name: {
    alignItems: "center",
    columnGap: 6,
    display: "inline-flex",
  },
  regionNote: {
    color: color.inkMuted,
    display: "block",
    paddingInlineStart: 16,
  },
  actions: {
    columnGap: 8,
    display: "flex",
    flexWrap: "nowrap",
  },
  /** The 28 px button of the tool, with small text. */
  small: {
    fontSize: textSize.small,
  },
  hexCell: {
    paddingBlockEnd: 8,
  },
  // The dump scrolls in its box. A width of 0 with a minimum of the full
  // cell keeps its long lines out of the table width.
  hex: {
    backgroundColor: color.panel,
    borderColor: color.rule,
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    minWidth: "100%",
    width: 0,
  },
  pre: {
    font: `${textSize.small}/18px ${font.mono}`,
    margin: 0,
    maxHeight: 320,
    overflow: "auto",
    padding: size.gutter,
    whiteSpace: "pre",
  },
  hexFooter: {
    alignItems: "center",
    borderTopColor: color.rule,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    color: color.inkMuted,
    display: "flex",
    fontSize: textSize.small,
    justifyContent: "space-between",
    // A touch screen gets room for the full hit area of "Load more".
    minHeight: { default: null, "@media (pointer: coarse)": 36 },
    paddingBlock: 4,
    paddingInline: size.gutter,
  },
  link: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: color.water,
    cursor: "pointer",
    font: "inherit",
    padding: 0,
  },
});
