// The preview of one entry: its metadata, the Extract and Copy path
// actions, notes about the local header and the encoding, the contents
// and a footer with "Load more". The pane and the popup window both use it.
// Text shows only as text nodes; images show only through <img>.
import * as stylex from "@stylexjs/stylex";
import { Portal } from "@solidjs/web";
import { createMemo, createSignal, For, from, Match, onCleanup, Show, Switch } from "solid-js";
import { LocalMismatch } from "../contracts";
import type { EntryCheck } from "../contracts";
import { exactBytes, formatMethod, formatModified, formatRatio, formatSize } from "../format";
import type { ArchiveSession } from "../session";
import { controls } from "../shell/controls";
import { Icon } from "../shell/icons";
import { color, font, size, textSize } from "../theme/tokens.stylex";
import { ExtractSlot } from "../shell/ExtractSlot";
import type { ExtractRequest } from "../shell/ExtractSlot";
import { crcFailed, EntryLoader } from "./load";
import type { EntryLoad, PreviewView } from "./load";
import { chunkLines, hexDump, lineCount } from "./sniff";
import { listedTarget } from "./target";
import type { PreviewTarget } from "./target";
import { nameLabel, nameText, nameTitle } from "../label";

export interface EntryPreviewProps {
  session: ArchiveSession;
  target: PreviewTarget | undefined;
  /** The count of listed rows. The preview shows a target only when its
   *  row is listed. */
  rows: number;
  /** The window that shows the preview: the app or the popup. */
  view?: Window;
  /** The element of the title strip that takes the actions of the entry. */
  actions?: HTMLElement | undefined;
  /** Called with the check of each row that loads. */
  onCheck?: (row: number, check: EntryCheck) => void;
  /** Called when the data of a row does not agree with its CRC-32. */
  onCrcFailure?: (row: number) => void;
}

/** Explains the mismatch bits of a local header check. */
export function mismatchText(check: EntryCheck): string | undefined {
  const parts: string[] = [];
  if (check.mismatches & LocalMismatch.NAME) parts.push(`the name (${nameLabel(check.localName)})`);
  if (check.mismatches & LocalMismatch.SIZES) parts.push("the sizes");
  if (check.mismatches & LocalMismatch.CRC) parts.push("the CRC-32");
  if (check.mismatches & LocalMismatch.METHOD) parts.push("the method");
  if (parts.length === 0) return undefined;
  return `The local header does not agree with the central directory: ${parts.join(", ")}. The listing and this preview use the central directory.`;
}

const hex8 = (value: number) => (value >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** The actions of an entry, in the tool form of the strip line, so the two
 *  Extract controls of a screen have one form and say what they act on. */
function Actions(props: { extract: () => void; copyPath: () => void }) {
  return (
    <>
      <button
        id="preview-extract"
        type="button"
        aria-label="Extract file"
        title="Extract file"
        onClick={() => props.extract()}
        {...stylex.attrs(controls.tool, controls.toolLabelled, controls.focusRing)}
      >
        <Icon name="download" />
        Extract file
      </button>
      <button
        id="preview-copy-path"
        type="button"
        aria-label="Copy path"
        title="Copy path"
        onClick={() => props.copyPath()}
        {...stylex.attrs(controls.iconButton, controls.focusRing)}
      >
        <Icon name="copy" />
      </button>
    </>
  );
}

export function EntryPreview(props: EntryPreviewProps) {
  const reader = props.session.reader;
  const win = () => props.view ?? window;
  /** The extraction of the Extract button. It does not follow
   *  the target: it ends in its own dialog. */
  const [extraction, setExtraction] = createSignal<ExtractRequest>();
  /** True while the plan or the extraction runs. */
  let extracting = false;
  const loader = new EntryLoader({
    read: (row, offset, bytes) => props.session.read.read(row, offset, bytes),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    onCheck: (row, check) => props.onCheck?.(row, check),
    onCrcFailure: (row) => props.onCrcFailure?.(row),
  });

  /** The target, when its row is listed. */
  const listed = listedTarget(
    () => props.target,
    () => props.rows,
  );
  /** The message of the last action. A new target clears it. */
  const [action, setAction] = createSignal<string>(() => {
    listed();
    return "";
  });
  /** Shows the message of an action on `target`. An action can end after
   *  the preview moved to another entry: then its message does not show. */
  const report = (target: PreviewTarget, text: string) => {
    if (listed() === target) setAction(text);
  };
  /** The view of the listed target. Each target gets its own load: when
   *  the target changes or the preview closes, the owner stops the load.
   *  The first view comes at once, so no loading boundary is necessary. */
  /** The load of the target that shows, for "Load more". */
  let current: EntryLoad | undefined;
  const view = createMemo<PreviewView | undefined>(() => {
    const target = listed();
    if (target === undefined) return undefined;
    const declared = reader.value(target.row, "uncompressedSize");
    return from<PreviewView>((next) => {
      const loading = loader.load(target.row, target.name, declared, next);
      current = loading;
      return () => loading.cancel();
    });
  });
  /** The view while it shows its entry. */
  const ready = () => {
    const shown = view();
    return shown?.status === "ready" ? shown : undefined;
  };
  const textView = () => {
    const shown = ready();
    return shown?.kind === "text" ? shown : undefined;
  };
  const hexView = () => {
    const shown = ready();
    return shown?.kind === "hex" ? shown : undefined;
  };
  const imageView = () => {
    const shown = ready();
    return shown?.kind === "image" ? shown : undefined;
  };
  /** The local header note, or undefined. */
  const mismatch = () => {
    const shown = view();
    const check = shown === undefined || shown.status === "loading" ? undefined : shown.check;
    return check === undefined ? undefined : mismatchText(check);
  };
  /** Why the entry cannot show, or why decoding stopped. */
  const problem = () => {
    const shown = view();
    if (shown?.status === "error") return shown.error;
    const stopped = ready()?.error;
    if (stopped === undefined) return undefined;
    // The data of a CRC-32 failure shows, but it can be wrong. Extraction
    // does not keep such a file.
    return crcFailed(stopped)
      ? `Not verified: ${stopped}. The data below can have errors.`
      : `Decoding stopped: ${stopped}`;
  };

  const value = (column: Parameters<typeof reader.value>[1]) => {
    const target = listed();
    return target === undefined ? 0 : reader.value(target.row, column);
  };

  const copyPath = () => {
    const target = listed();
    if (target === undefined) return;
    const clipboard = win().navigator.clipboard;
    if (clipboard === undefined) {
      setAction("The browser does not allow copying here");
      return;
    }
    clipboard.writeText(target.name).then(
      () => report(target, "Path copied"),
      () => report(target, "The path could not be copied"),
    );
  };

  const extract = () => {
    const target = listed();
    if (target === undefined || extracting) return;
    setExtraction({ target: { kind: "entry", row: target.row }, label: target.name });
  };

  /** The result of the CRC-32 check, when the data ended. */
  const crcResult = () => {
    const shown = ready();
    if (shown === undefined) return undefined;
    if (shown.state === "verified" && shown.shown >= shown.loaded) return "verified";
    return shown.state === "failed" && crcFailed(shown.error) ? "not verified" : undefined;
  };
  /** The footer text, or undefined when the entry does not show. */
  const footer = () => {
    const shown = ready();
    if (shown === undefined) return undefined;
    const total = value("uncompressedSize");
    // The facts have the result of the check.
    if (crcResult() === "verified") return formatSize(total);
    if (crcResult() === "not verified") return `${formatSize(shown.shown)} of ${formatSize(total)}`;
    return `First ${formatSize(shown.shown)} of ${formatSize(total)}`;
  };

  return (
    <div id="entry-preview" {...stylex.attrs(styles.root)}>
      <Show
        when={listed()}
        fallback={
          <p {...stylex.attrs(styles.note, styles.pad)}>
            {props.target === undefined
              ? "Select a file in the list to preview it."
              : "This entry is not listed yet."}
          </p>
        }
      >
        {(target) => {
          const method = () =>
            formatMethod(value("method"), value("encryption"), value("aesMethod"));
          const modified = () => formatModified(value("modified"), value("timeKind"));
          return (
            <>
              <dl id="preview-meta" {...stylex.attrs(styles.meta)}>
                <div {...stylex.attrs(styles.fact)}>
                  <dt {...stylex.attrs(styles.term)}>Size</dt>
                  <dd {...stylex.attrs(styles.value, styles.pair)}>
                    <span
                      data-field="size"
                      title={exactBytes(value("uncompressedSize"))}
                      {...stylex.attrs(styles.lead)}
                    >
                      {formatSize(value("uncompressedSize"))}
                    </span>
                    <span
                      data-field="compressed"
                      title={`${exactBytes(value("compressedSize"))}, ${method().title}`}
                    >
                      {`${formatSize(value("compressedSize"))} compressed · ${formatRatio(
                        value("compressedSize"),
                        value("uncompressedSize"),
                      )} · ${method().text}`}
                    </span>
                  </dd>
                </div>
                <div {...stylex.attrs(styles.fact)}>
                  <dt {...stylex.attrs(styles.term)}>Modified</dt>
                  <dd {...stylex.attrs(styles.value, styles.pair)}>
                    <span data-field="modified" title={modified().title}>
                      {modified().text}
                    </span>
                    {/* The result of the check is part of this fact. */}
                    <span>
                      <span {...stylex.attrs(styles.term)}>CRC-32 </span>
                      <span data-field="crc32" {...stylex.attrs(styles.mono)}>
                        {hex8(value("crc32"))}
                      </span>
                      <Show when={crcResult()}>
                        {(result) => (
                          <span
                            id="preview-crc-result"
                            data-result={result()}
                            {...stylex.attrs(result() === "not verified" && styles.crcFailed)}
                          >
                            {` ${result()}`}
                          </span>
                        )}
                      </Show>
                    </span>
                  </dd>
                </div>
                <div {...stylex.attrs(styles.fact)}>
                  <dt {...stylex.attrs(styles.term)}>Path</dt>
                  <dd
                    data-field="path"
                    dir="ltr"
                    title={nameTitle(target().name)}
                    {...stylex.attrs(styles.value, styles.path)}
                  >
                    {nameLabel(target().name)}
                  </dd>
                </div>
              </dl>
              {/* The actions of the entry are in the title strip of the pane.
                  The popup has a strip of its own, so they are a row there. */}
              <Show
                when={props.actions}
                fallback={
                  <div {...stylex.attrs(styles.actions)}>
                    <Actions extract={extract} copyPath={copyPath} />
                  </div>
                }
              >
                {(mount) => (
                  <Portal mount={mount()}>
                    <Actions extract={extract} copyPath={copyPath} />
                  </Portal>
                )}
              </Show>
              <output id="preview-action" aria-live="polite" {...stylex.attrs(styles.actionNote)}>
                {action()}
              </output>
              <Show when={mismatch()}>
                {(text) => (
                  <p
                    id="preview-mismatch"
                    role="alert"
                    {...stylex.attrs(styles.banner, styles.warn)}
                  >
                    {text()}
                  </p>
                )}
              </Show>
              <Show when={textView()?.text.encoding === "windows-1252"}>
                <p id="preview-encoding" {...stylex.attrs(styles.banner, styles.info)}>
                  This text is not valid UTF-8. It shows as Windows-1252.
                </p>
              </Show>
              <Show when={ready()?.note}>
                {(note) => (
                  <p id="preview-note" {...stylex.attrs(styles.banner, styles.info)}>
                    {note()}
                  </p>
                )}
              </Show>
              <Show when={problem()}>
                {(text) => (
                  <p id="preview-error" role="alert" {...stylex.attrs(styles.banner, styles.crit)}>
                    {text()}
                  </p>
                )}
              </Show>
              <div id="preview-content" {...stylex.attrs(styles.content)}>
                <Switch>
                  <Match when={view() === undefined || view()?.status === "loading"}>
                    <p {...stylex.attrs(styles.note, styles.pad)}>Loading…</p>
                  </Match>
                  <Match when={textView()}>
                    {(shown) => <TextLines text={shown().text.text} />}
                  </Match>
                  <Match when={hexView()}>
                    {(shown) => <HexView bytes={shown().bytes} view={win()} />}
                  </Match>
                  <Match when={imageView()}>
                    {(shown) => (
                      <Show
                        when={shown().image}
                        fallback={<p {...stylex.attrs(styles.note, styles.pad)}>Loading image…</p>}
                      >
                        {(url) => (
                          <img
                            id="preview-image"
                            data-kind="image"
                            src={url()}
                            alt={nameText(target().name)}
                            {...stylex.attrs(styles.image)}
                          />
                        )}
                      </Show>
                    )}
                  </Match>
                </Switch>
              </div>
              <Show when={footer()}>
                {(text) => (
                  <div id="preview-footer" {...stylex.attrs(styles.footer)}>
                    <span>{text()}</span>
                    <Show when={ready()?.more}>
                      <button
                        id="preview-more"
                        type="button"
                        disabled={ready()?.busy}
                        onClick={() => void current?.more()}
                        {...stylex.attrs(styles.link, controls.focusRing, controls.touchArea)}
                      >
                        Load more
                      </button>
                    </Show>
                  </div>
                )}
              </Show>
            </>
          );
        }}
      </Show>
      <Show when={extraction()} keyed>
        {(request) => (
          <ExtractSlot
            session={props.session}
            request={request}
            view={win()}
            onClose={() => setExtraction(undefined)}
            onBusy={(busy) => {
              extracting = busy;
            }}
          />
        )}
      </Show>
    </div>
  );
}

/** Below this width a 16-byte hex line (77 characters of 12 px mono and
 *  the gutters) does not fit. */
const HEX_WIDE = 580;

/** The most lines that wrap. Each line is an element, so a longer text
 *  keeps one text node with sideways scrolling and the fade at the edge. */
const WRAP_LINES = 5000;

/**
 * The text view. Lines wrap, so they are not cut at the edge of the pane,
 * and the line number stays on the first visual line of its line. The
 * numbers are generated content, so they are not in the text that the user
 * selects.
 */
function TextLines(props: { text: string }) {
  const count = () => lineCount(props.text);
  const lines = () => props.text.split(/(?<=\n)/);
  return (
    <Show
      when={count() <= WRAP_LINES}
      fallback={
        <div data-kind="text" {...stylex.attrs(styles.code)}>
          <pre aria-hidden="true" {...stylex.attrs(styles.pre, styles.lines)}>
            {Array.from({ length: count() }, (_, line) => line + 1).join("\n")}
          </pre>
          <pre id="preview-text" {...stylex.attrs(styles.pre, styles.textPre)}>
            {props.text}
          </pre>
          {/* A 12 px fade at the visible right edge, so a line that goes on
              is not cut on the pane edge. */}
          <span aria-hidden="true" {...stylex.attrs(styles.edge)} />
        </div>
      }
    >
      <div
        id="preview-text"
        data-kind="text"
        style={{ "--line-digits": String(String(count()).length) }}
        {...stylex.attrs(styles.wrapped)}
      >
        {lines().map((line) => (
          <div {...stylex.attrs(styles.wrappedLine)}>{line}</div>
        ))}
      </div>
    </Show>
  );
}

/** The lines in one chunk of a hex column. */
const HEX_CHUNK = 256;

/** A hex dump in three columns: the offsets and the characters in ink
 *  muted, as the line numbers of the text view, and the bytes in ink. It has
 *  16 bytes on each line when the pane has room, else 8, so that no byte is cut
 *  at the edge. It makes only the dump for the width that shows.
 *
 *  Each column is a stack of chunks of lines. The browser does not lay out a
 *  chunk that is far from the view, thus "Load more" does not lay out all the
 *  lines again. The text of each chunk stays in the page, for selection, copy
 *  and find. */
function HexView(props: { bytes: Uint8Array; view: Window }) {
  const [width, setWidth] = createSignal<number>();
  const perLine = createMemo(() => {
    const known = width();
    if (known === undefined) return undefined;
    return known < HEX_WIDE ? 8 : 16;
  });
  const columns = createMemo(() => {
    const per = perLine();
    if (per === undefined) return undefined;
    const lines = hexDump(props.bytes, 0, per).split("\n");
    /** Where the characters start: the bytes have no "|". */
    const bar = (line: string) => line.indexOf("|");
    const column = (part: (line: string) => string) => chunkLines(lines.map(part), HEX_CHUNK);
    return {
      offsets: column((line) => line.slice(0, 8)),
      bytes: column((line) => line.slice(10, bar(line)).trimEnd()),
      text: column((line) => line.slice(bar(line))),
    };
  });
  return (
    <div
      ref={(element) => {
        // The observer of the window that shows the view: the popup has its own.
        const view = props.view as unknown as typeof globalThis;
        const observer = new view.ResizeObserver(() => setWidth(element.clientWidth));
        observer.observe(element);
        onCleanup(() => observer.disconnect());
      }}
    >
      <Show when={columns()}>
        {(shown) => (
          <div id="preview-hex" data-kind="hex" {...stylex.attrs(styles.hexGrid)}>
            <HexColumn chunks={shown().offsets} style={styles.lines} />
            <HexColumn chunks={shown().bytes} />
            <HexColumn chunks={shown().text} style={styles.hexText} />
          </div>
        )}
      </Show>
    </div>
  );
}

/** A column of the hex view. A chunk keeps its element when "Load more"
 *  adds lines, thus only the last chunk and the new chunks change. The
 *  column is as wide as its first line, which is its longest line. The
 *  browser does not measure the lines of a chunk that it does not lay out,
 *  thus the width cannot come from the chunks. */
function HexColumn(props: { chunks: string[]; style?: stylex.StyleXStyles }) {
  const chars = () => (props.chunks[0] ?? "").split("\n", 1)[0]!.length;
  return (
    <div
      style={{ "--hex-chars": String(chars()) }}
      {...stylex.attrs(styles.pre, styles.hexColumn, props.style)}
    >
      <For each={props.chunks} keyed={false}>
        {(chunk) => <pre {...stylex.attrs(styles.pre, styles.hexChunk)}>{chunk()}</pre>}
      </For>
    </div>
  );
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    height: "100%",
  },
  pad: {
    padding: size.gutter,
  },
  /** A label-value grid, with one column of labels. */
  meta: {
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    columnGap: 12,
    display: "grid",
    fontSize: textSize.small,
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    margin: 0,
    paddingBlock: 10,
    paddingInline: size.gutter,
    rowGap: 2,
  },
  fact: {
    display: "contents",
  },
  term: {
    color: color.inkMuted,
  },
  value: {
    margin: 0,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  /** A very long path scrolls, so the content and Load more stay in the pane.
   *  The title has the full path. */
  path: {
    maxBlockSize: "4lh",
    overflowY: "auto",
  },
  /** Two facts in one value. The second goes to the next line with no room. */
  pair: {
    columnGap: 12,
    display: "flex",
    flexWrap: "wrap",
  },
  /** The lead fact, at the weight of a large size in the table. */
  lead: {
    fontWeight: 600,
  },
  crcFailed: {
    color: color.crit,
  },
  mono: {
    fontFamily: font.mono,
  },
  /** The result of an action. It takes no room while it is empty. */
  actionNote: {
    color: color.inkMuted,
    display: { default: "block", ":empty": "none" },
    fontSize: textSize.small,
    paddingBlock: 4,
    paddingInline: size.gutter,
  },
  actions: {
    alignItems: "center",
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    columnGap: 8,
    display: "flex",
    flexWrap: "wrap",
    paddingBlock: 10,
    paddingInline: size.gutter,
    rowGap: 8,
  },
  note: {
    color: color.inkMuted,
    fontSize: textSize.small,
    margin: 0,
    minWidth: 0,
  },
  banner: {
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    fontSize: textSize.small,
    margin: 0,
    paddingBlock: 8,
    paddingInline: size.gutter,
  },
  warn: {
    backgroundColor: color.warnBg,
    color: color.warn,
  },
  crit: {
    backgroundColor: color.critBg,
    color: color.crit,
  },
  info: {
    backgroundColor: color.panel,
    color: color.inkMuted,
  },
  content: {
    flexGrow: 1,
    minHeight: 0,
    overflow: "auto",
  },
  /** As wide as its longest line (at least the pane), so the sticky edge
   *  can follow the scroll to the end of the lines. */
  code: {
    boxSizing: "border-box",
    columnGap: 10,
    minWidth: "100%",
    width: "max-content",
    display: "grid",
    gridTemplateColumns: `auto minmax(0, 1fr) ${size.gutter}`,
    paddingBlock: 6,
  },
  pre: {
    font: `${textSize.small}/20px ${font.mono}`,
    margin: 0,
    whiteSpace: "pre",
  },
  /** The text is as wide as its longest line, with the gutter after
   *  it, so that a line that scrolls does not end at the pane edge. */
  textPre: {
    width: "max-content",
  },
  edge: {
    alignSelf: "stretch",
    backgroundImage: `linear-gradient(to right, transparent, ${color.ground})`,
    gridColumn: 3,
    gridRow: 1,
    insetInlineEnd: 0,
    position: "sticky",
    width: size.gutter,
  },
  /** The block uses the width of the pane: the characters are at its end. */
  hexGrid: {
    columnGap: 24,
    display: "grid",
    gridTemplateColumns: "auto auto auto",
    justifyContent: "space-between",
    paddingBlock: 6,
    paddingInlineEnd: size.gutter,
  },
  hexText: {
    color: color.inkMuted,
  },
  /** The browser rounds the width of a text up to 1/64 px, thus the width
   *  of the column is the same as the width of its lines. */
  hexColumn: {
    width: "round(up, var(--hex-chars) * 1ch, 1px / 64)",
  },
  /** The browser does not lay out or paint a chunk that is far from the
   *  view, and gives it the block size of a full chunk. The last chunk can
   *  be shorter, thus the browser always lays it out. The clip margin lets
   *  the selection mark of a line end go past the chunk, as in one block. */
  hexChunk: {
    containIntrinsicBlockSize: `${HEX_CHUNK}lh`,
    contentVisibility: { default: "auto", ":last-child": "visible" },
    overflowClipMargin: "1ch",
  },
  /** The text view with lines that wrap. */
  wrapped: {
    counterReset: "line",
    font: `${textSize.small}/20px ${font.mono}`,
    paddingBlock: 6,
  },
  /** A line: its number in a column, and its text with a 12 px gutter at the
   *  end. A wrapped line continues below the start of its text. */
  wrappedLine: {
    columnGap: 10,
    counterIncrement: "line",
    display: "grid",
    gridTemplateColumns: "calc(var(--line-digits) * 1ch + 12px) minmax(0, 1fr)",
    overflowWrap: "anywhere",
    // Between logical lines, so a wrapped line reads as one.
    paddingBlockEnd: 3,
    paddingInlineEnd: size.gutter,
    whiteSpace: "pre-wrap",
    "::before": {
      color: color.inkMuted,
      content: "counter(line)",
      // The numbers start on the gutter, as the facts and the hex offsets.
      paddingInlineStart: size.gutter,
      userSelect: "none",
    },
  },
  lines: {
    color: color.inkMuted,
    paddingInlineStart: size.gutter,
    textAlign: "right",
    userSelect: "none",
  },
  image: {
    display: "block",
    maxWidth: "100%",
    padding: size.gutter,
    boxSizing: "border-box",
  },
  footer: {
    alignItems: "center",
    backgroundColor: color.panel,
    borderTopColor: color.rule,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    color: color.inkMuted,
    display: "flex",
    flexShrink: 0,
    fontSize: textSize.small,
    // A touch screen gets 36 px, so "Load more" has its full hit area.
    height: { default: 28, "@media (pointer: coarse)": 36 },
    justifyContent: "space-between",
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
