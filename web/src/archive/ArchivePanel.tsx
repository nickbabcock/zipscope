// The Archive panel. Selecting the archive root opens it in
// the preview pane. It shows the archive comment, the totals with
// breakdowns, a link to the health findings, a byte map of the whole file,
// the format facts, the zstd copy, and the build in its footer. A part that
// has nothing to tell does not show.
//
// The read worker reads the end of the archive at once, and maps the
// bytes when the listing has ended. This module loads lazily, so the main
// bundle does not carry it.
import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, from, Match, Show, Switch } from "solid-js";
import { Encryption, State } from "../contracts";
import type { ArchiveFacts, ArchiveTotals, Breakdown } from "../contracts";
import { BUILD_SHA } from "../build";
import { exactBytes, formatRatio, formatSize } from "../format";
import { OVERLAP_FINDING, OVERLAP_NO_DATA_FINDING, WRAPPED_FINDING } from "../health/findings";
import type { Finding } from "../health/findings";
import type { ArchiveSession } from "../session";
import { MirrorReader } from "../store/reader";
import { controls } from "../shell/controls";
import { Icon } from "../shell/icons";
import { color, font, size, textSize } from "../theme/tokens.stylex";
import { ByteMap, TableColumns } from "./ByteMap";
import {
  BREAKDOWN_FIRST,
  BREAKDOWN_STEP,
  aboutCount,
  decodeComment,
  encryptionLabel,
  formatFacts,
  wrappedFact,
  factText,
  methodName,
  pageGroups,
  panel,
  systemName,
} from "./strings";
import type { Fact, ListingStatus } from "./strings";
import { commentText } from "../label";

export interface ArchivePanelProps {
  session: ArchiveSession;
  /** The count of listed rows. */
  rows: number;
  /** The health findings of the archive. */
  findings: Finding[];
  /** Opens the list of the health findings. */
  onShowHealth: () => void;
  /** Opens the dialog of the zstd copy. */
  onRemux: () => void;
}

/** A value that comes from the read worker. Errors stay data. */
type Loaded<T> =
  | { status: "waiting" }
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Follows a request of the read worker. `wait` resolves when the request
 *  can start. The owner stops the subscription. */
function follow<T>(request: () => Promise<T>, wait?: Promise<unknown>) {
  return createMemo(() =>
    from<Loaded<T>>((emit) => {
      let live = true;
      emit({ status: wait === undefined ? "loading" : "waiting" });
      const start = async () => {
        if (wait !== undefined) {
          await wait;
          if (live) emit({ status: "loading" });
        }
        return request();
      };
      start().then(
        (value) => {
          if (live) emit({ status: "ready", value });
        },
        (err: unknown) => {
          if (live) emit({ status: "error", message: message(err) });
        },
      );
      return () => {
        live = false;
      };
    }),
  );
}

export default function ArchivePanel(props: ArchivePanelProps) {
  const session = props.session;
  const facts = follow(() => session.read.facts());
  /** The totals come from a fast pass of their own, before the byte map. The
   *  worker runs one pass at a time, so this request must be the first. */
  const counted = follow(() => session.read.totals(), session.finished);
  const layout = follow(() => session.read.layout(), session.finished);
  /** The outcome of the parse, as soon as it ended. The byte map comes later,
   *  so it cannot tell whether the listing ended. */
  const outcome = follow(() => session.finished);

  const ready = <T,>(loaded: Loaded<T>): T | undefined =>
    loaded.status === "ready" ? loaded.value : undefined;
  const failed = (loaded: Loaded<unknown>): string | undefined =>
    loaded.status === "error" ? loaded.message : undefined;
  const factsValue = () => ready(facts());
  const layoutValue = () => ready(layout());
  /** The facts when the archive has a comment. */
  const commented = () => {
    const known = factsValue();
    return known !== undefined && known.comment.length > 0 ? known : undefined;
  };
  /** The byte map when it was made, else why it was not. */
  const mapped = () => {
    const map = layoutValue()?.map;
    return map?.ok === true ? map : undefined;
  };
  const mapError = () => {
    const map = layoutValue()?.map;
    return map?.ok === false ? map.error : failed(layout());
  };

  /** How far the listing came, and its rows. */
  const listing = (): ListingStatus => {
    const end = ready(outcome());
    return end === undefined ? "parsing" : end.kind === "complete" ? "complete" : "partial";
  };
  const totalsValue = () => ready(counted()) ?? layoutValue()?.totals;
  const listedRows = () => totalsValue()?.entries ?? props.rows;
  /** The sums of the root folder from the views: they show at once and during
   *  the parse, and they are the same sums as the counted totals. */
  const sums = () => {
    const known = totalsValue();
    if (known !== undefined) return known;
    const entries = props.rows;
    const views = session.reader.views();
    const root = views === undefined ? undefined : MirrorReader.rollup(views, 0);
    return root === undefined ? undefined : { uncompressed: root[0], compressed: root[1], entries };
  };
  /** A fact with one group goes to the Format section, so the totals are only
   *  the four answers. */
  const oneGroup = (groups: Breakdown[] | undefined) =>
    groups !== undefined && groups.length === 1 ? groups[0] : undefined;
  const moreFacts = (): Fact[] => {
    const known = totalsValue();
    const more: Fact[] = [];
    const encryption = oneGroup(known?.encryption);
    if (encryption !== undefined && encryption.key !== Encryption.NONE) {
      more.push({ id: "encryption", term: "Encryption", value: encryptionLabel(encryption.key) });
    }
    const system = oneGroup(known?.systems);
    if (system !== undefined) {
      more.push({ id: "system", term: "System", value: systemName(system.key) });
    }
    return more;
  };

  /** Rows that start on another disk, from the map. */
  const otherDiskRows = () => mapped()?.counts.otherDiskRows ?? 0;

  const mapBusy = () => layout().status === "waiting" || layout().status === "loading";
  /** The height of the map when the bytes after the end record show that it
   *  has a bar and a list, so the sections below do not move when it comes. A
   *  file with no such bytes usually has one sentence. */
  const mapReserve = () => {
    const known = factsValue();
    return known !== undefined && known.size > known.endOffset
      ? { "min-height": `${MAP_HEIGHT}px` }
      : undefined;
  };

  return (
    <div id="archive-panel" {...stylex.attrs(styles.root)}>
      <Show when={session.info.demo}>
        <p id="archive-demo" {...stylex.attrs(styles.demo)}>
          <span>{panel.demo}</span>
        </p>
      </Show>
      {/* The comment shows only when the archive has one. The read error
          of the end of the archive shows here, at the top. */}
      <Switch>
        <Match when={failed(facts())}>
          {(text) => (
            <Section id="archive-comment" title={panel.comment}>
              <Problem text={text()} />
            </Section>
          )}
        </Match>
        <Match when={commented()}>
          {(known) => (
            <Section id="archive-comment" title={panel.comment}>
              <Comment facts={known()} />
            </Section>
          )}
        </Match>
      </Switch>

      {/* The answers first: the totals and the health, then the byte
          map and the format, then the action. */}
      <Section id="archive-totals" title={panel.totals}>
        <Show when={sums()}>{(known) => <Sums sums={known()} />}</Show>
        <Show when={totalsValue()}>{(known) => <Breakdowns totals={known()} />}</Show>
        {/* The health strip and its list have the findings. The panel only
            links to them, below the totals, with no section
            of its own. */}
        <Show when={props.findings.length > 0}>
          <p id="archive-health" {...stylex.attrs(styles.line)}>
            <button
              id="archive-health-link"
              type="button"
              aria-controls="health-panel"
              onClick={() => props.onShowHealth()}
              {...stylex.attrs(styles.link, styles.smallText, controls.focusRing)}
            >
              {panel.showFindings(props.findings.length)}
            </button>
          </p>
        </Show>
      </Section>

      <Section id="archive-map" title={panel.map} busy={mapBusy()}>
        <Switch>
          <Match when={layout().status === "waiting"}>
            <p {...stylex.attrs(styles.muted, styles.mapWait)}>{panel.waiting}</p>
          </Match>
          <Match when={mapError()}>{(text) => <Problem text={text()} />}</Match>
          <Match when={mapped()}>
            {(map) => (
              <ByteMap
                file={session.file}
                archiveName={session.info.name}
                regions={map().regions}
                counts={map().counts}
                partial={layoutValue()?.state !== State.COMPLETE}
                overlapFinding={props.findings.some(
                  (finding) =>
                    finding.id === OVERLAP_FINDING || finding.id === OVERLAP_NO_DATA_FINDING,
                )}
              />
            )}
          </Match>
          <Match when={true}>
            <p {...stylex.attrs(styles.muted, styles.mapWait)} style={mapReserve()}>
              {panel.mapping}
            </p>
          </Match>
        </Switch>
      </Section>

      <Section id="archive-format" title={panel.format}>
        <Show when={factsValue()} fallback={<p {...stylex.attrs(styles.muted)}>{panel.loading}</p>}>
          {(known) => (
            <dl {...stylex.attrs(styles.facts)}>
              <For
                each={formatFacts(
                  known(),
                  listedRows(),
                  listing(),
                  otherDiskRows(),
                  mapped()?.counts.zip64Rows ?? 0,
                  [
                    ...(props.findings.some((finding) => finding.id === WRAPPED_FINDING)
                      ? [wrappedFact(known())]
                      : []),
                    ...moreFacts(),
                  ],
                )}
              >
                {(fact) => (
                  <div data-fact={fact.id} {...stylex.attrs(styles.fact)}>
                    <dt {...stylex.attrs(styles.term)}>{fact.term}</dt>
                    <dd
                      data-level={fact.level}
                      {...stylex.attrs(
                        styles.value,
                        styles.factValue,
                        fact.level === "warning" && styles.warn,
                        fact.level === "error" && styles.crit,
                      )}
                    >
                      {factText(fact.value)}
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          )}
        </Show>
      </Section>

      <Section id="archive-remux" title={panel.remux}>
        <p {...stylex.attrs(styles.muted)}>{panel.remuxNote}</p>
        <p {...stylex.attrs(styles.line)}>
          <button
            id="remux-button"
            type="button"
            onClick={() => props.onRemux()}
            {...stylex.attrs(controls.button, controls.focusRing, styles.small)}
          >
            <Icon name="remux" />
            {panel.remuxButton}
          </button>
        </p>
      </Section>

      <footer id="archive-footer" {...stylex.attrs(styles.footer)}>
        <span id="archive-build">{panel.build(BUILD_SHA)}</span>
      </footer>
    </div>
  );
}

function Section(props: { id: string; title: string; busy?: boolean; children: JSX.Element }) {
  return (
    <section
      id={props.id}
      aria-labelledby={`${props.id}-title`}
      aria-busy={props.busy === true ? "true" : undefined}
      tabindex="-1"
      {...stylex.attrs(styles.section)}
    >
      <h2 id={`${props.id}-title`} {...stylex.attrs(styles.title)}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Problem(props: { text: string }) {
  return (
    <p role="alert" {...stylex.attrs(styles.problem)}>
      {props.text}
    </p>
  );
}

function Comment(props: { facts: ArchiveFacts }) {
  const cut = () => props.facts.comment.length < props.facts.endRecord.commentLength;
  const decoded = createMemo(() => decodeComment(props.facts.comment, cut()));
  return (
    <>
      <pre id="archive-comment-text" dir="auto" {...stylex.attrs(styles.comment)}>
        {commentText(decoded().text)}
      </pre>
      <Show when={decoded().encoding === "cp437"}>
        <p id="archive-comment-encoding" {...stylex.attrs(styles.muted)}>
          {panel.cp437}
        </p>
      </Show>
      <Show when={cut()}>
        <p id="archive-comment-cut" {...stylex.attrs(styles.muted)}>
          {panel.commentCut(
            formatSize(props.facts.comment.length),
            formatSize(props.facts.endRecord.commentLength),
          )}
        </p>
      </Show>
    </>
  );
}

/** The four answers. */
function Sums(props: { sums: { entries: number; uncompressed: number; compressed: number } }) {
  return (
    <dl id="archive-sums" {...stylex.attrs(styles.sums)}>
      <div {...stylex.attrs(styles.sum)}>
        <dt {...stylex.attrs(styles.term)}>Entries</dt>
        <dd data-total="entries" {...stylex.attrs(styles.sumValue)}>
          {aboutCount(props.sums.entries)}
        </dd>
      </div>
      <div {...stylex.attrs(styles.sum)}>
        <dt {...stylex.attrs(styles.term)}>Size</dt>
        <dd
          data-total="uncompressed"
          title={exactBytes(props.sums.uncompressed)}
          {...stylex.attrs(styles.sumValue)}
        >
          {formatSize(props.sums.uncompressed)}
        </dd>
      </div>
      <div {...stylex.attrs(styles.sum)}>
        <dt {...stylex.attrs(styles.term)}>Compressed</dt>
        <dd
          data-total="compressed"
          title={exactBytes(props.sums.compressed)}
          {...stylex.attrs(styles.sumValue)}
        >
          {formatSize(props.sums.compressed)}
        </dd>
      </div>
      <div {...stylex.attrs(styles.sum)}>
        <dt {...stylex.attrs(styles.term)}>Ratio</dt>
        <dd data-total="ratio" {...stylex.attrs(styles.sumValue)}>
          {formatRatio(props.sums.compressed, props.sums.uncompressed)}
        </dd>
      </div>
    </dl>
  );
}

/** The breakdowns of the totals. A breakdown with one group is one fact in
 *  the Format section, and an empty breakdown does not show. */
function Breakdowns(props: { totals: ArchiveTotals }) {
  const totals = () => props.totals;
  return (
    <>
      <Show when={totals().methods.length > 0}>
        <BreakdownTable
          id="archive-methods"
          title="By method"
          groups={totals().methods}
          name={methodName}
          other="methods"
          compressed
        />
      </Show>
      <Show when={totals().encryption.length > 1}>
        <BreakdownTable
          id="archive-encryption"
          title="By encryption"
          groups={totals().encryption}
          name={encryptionLabel}
          other="kinds"
        />
      </Show>
      <Show when={totals().systems.length > 1}>
        <BreakdownTable
          id="archive-systems"
          title="By creating system"
          groups={totals().systems}
          name={systemName}
          other="systems"
        />
      </Show>
    </>
  );
}

/** One breakdown of the totals. It shows the groups with the most entries
 *  first, `BREAKDOWN_FIRST` at first and `BREAKDOWN_STEP` more on each
 *  "Show more", and one row with the totals of the other groups. Thus the
 *  DOM stays small also for an archive with 65,536 methods. */
function BreakdownTable(props: {
  id: string;
  title: string;
  groups: Breakdown[];
  name: (key: number) => string;
  /** The plural noun of the other groups: "methods". */
  other: string;
  compressed?: boolean;
}) {
  const [shown, setShown] = createSignal(BREAKDOWN_FIRST);
  const page = createMemo(() => pageGroups(props.groups, shown()));
  const cells = (group: { entries: number; uncompressed: number; compressed: number }) => (
    <>
      <td {...stylex.attrs(styles.cell, styles.number)}>{aboutCount(group.entries)}</td>
      <td title={exactBytes(group.uncompressed)} {...stylex.attrs(styles.cell, styles.number)}>
        {formatSize(group.uncompressed)}
      </td>
      <Show when={props.compressed}>
        <td title={exactBytes(group.compressed)} {...stylex.attrs(styles.cell, styles.number)}>
          {formatSize(group.compressed)}
        </td>
      </Show>
    </>
  );
  return (
    <table id={props.id} tabindex="-1" {...stylex.attrs(styles.table)}>
      <TableColumns />
      {/* The first column header names the breakdown, so the caption is
          for a screen reader. */}
      <caption {...stylex.attrs(controls.visuallyHidden)}>{props.title}</caption>
      <thead>
        <tr>
          <th scope="col" {...stylex.attrs(styles.head)}>
            {props.title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase())}
          </th>
          <th scope="col" {...stylex.attrs(styles.head, styles.number)}>
            Entries
          </th>
          <th scope="col" {...stylex.attrs(styles.head, styles.number)}>
            Size
          </th>
          <Show when={props.compressed}>
            <th scope="col" {...stylex.attrs(styles.head, styles.number)}>
              Compressed
            </th>
          </Show>
        </tr>
      </thead>
      <tbody>
        <For each={page().rows}>
          {(group) => (
            <tr data-key={group.key}>
              <td {...stylex.attrs(styles.cell)}>{props.name(group.key)}</td>
              {cells(group)}
            </tr>
          )}
        </For>
      </tbody>
      <Show when={page().rest}>
        {(rest) => (
          <tfoot>
            <tr data-part="other">
              <td {...stylex.attrs(styles.cell)}>
                {`${aboutCount(rest().groups)} other ${props.other}`}{" "}
                <button
                  type="button"
                  data-action="more-groups"
                  onClick={() => setShown((value) => value + BREAKDOWN_STEP)}
                  {...stylex.attrs(styles.link, controls.focusRing)}
                >
                  {panel.moreGroups(Math.min(BREAKDOWN_STEP, rest().groups))}
                </button>
              </td>
              {cells(rest())}
            </tr>
          </tfoot>
        )}
      </Show>
    </table>
  );
}

/** Below this width of the panel, the totals are two rows of two and the small
 *  tables have narrow number columns. */
const NARROW_PANEL = "@container (width < 420px)";
/** A bar, one summary line and about five regions with their actions. */
const MAP_HEIGHT = 240;

const styles = stylex.create({
  /** The build line follows the last section. */
  root: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  section: {
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    display: "flex",
    flexDirection: "column",
    outlineStyle: "none",
    // One structure for each section: the rule, 16 px, the label, 8 px.
    paddingBlock: 16,
    paddingInline: size.gutter,
    rowGap: 8,
  },
  /** A section label is sentence case, in ink at weight 600. Only a column
   *  header has the legend style, so the two levels look different. */
  title: {
    color: color.ink,
    fontSize: textSize.small,
    fontWeight: 600,
    margin: 0,
  },
  muted: {
    color: color.inkMuted,
    fontSize: textSize.small,
    margin: 0,
  },
  /** The one waiting line of the panel. */
  mapWait: {
    boxSizing: "border-box",
  },
  line: {
    margin: 0,
  },
  /** The 28 px button of the tool, with small text. */
  small: {
    fontSize: textSize.small,
  },
  problem: {
    backgroundColor: color.critBg,
    borderRadius: 4,
    color: color.crit,
    fontSize: textSize.small,
    margin: 0,
    paddingBlock: 6,
    paddingInline: 8,
  },
  comment: {
    font: `${textSize.small}/18px ${font.mono}`,
    margin: 0,
    maxHeight: 200,
    overflow: "auto",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  /** The format facts have the form of the preview facts: a label-value grid
   *  with one column of labels. Only the totals are stacked and bold. */
  facts: {
    columnGap: 12,
    display: "grid",
    fontSize: textSize.small,
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    margin: 0,
    rowGap: 2,
  },
  fact: {
    display: "contents",
  },
  factValue: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  term: {
    color: color.inkMuted,
  },
  value: {
    margin: 0,
    textWrap: "pretty",
  },
  warn: {
    color: color.warn,
  },
  crit: {
    color: color.crit,
  },
  /** A grid, so that the facts align in rows of the same columns and no
   *  fact is alone on a row of the panel. */
  sums: {
    columnGap: 16,
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(4, minmax(0, 1fr))",
      [NARROW_PANEL]: "repeat(2, minmax(0, 1fr))",
    },
    fontSize: textSize.small,
    margin: 0,
    rowGap: 6,
  },
  sum: {
    display: "flex",
    flexDirection: "column",
  },
  sumValue: {
    fontSize: textSize.title,
    fontWeight: 600,
    margin: 0,
  },
  table: {
    borderCollapse: "collapse",
    fontSize: textSize.small,
    outlineStyle: "none",
    tableLayout: "fixed",
    width: "100%",
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
  /** The 24 px row of the small tables of the panel. */
  cell: {
    height: 24,
    paddingBlock: 0,
    paddingInline: 0,
  },
  number: {
    paddingInlineStart: 8,
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  smallText: {
    fontSize: textSize.small,
  },
  link: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: color.water,
    cursor: "pointer",
    font: "inherit",
    padding: 0,
    textDecorationLine: "underline",
    textUnderlineOffset: 2,
  },
  demo: {
    alignItems: "center",
    color: color.inkMuted,
    columnGap: 8,
    display: "flex",
    fontSize: textSize.small,
    margin: 0,
    paddingBlockStart: 16,
    paddingInline: size.gutter,
  },
  footer: {
    color: color.inkMuted,
    fontSize: textSize.small,
    paddingBlock: 16,
    paddingInline: size.gutter,
  },
});
