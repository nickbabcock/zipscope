// The zstd remux dialog: the compatibility warning, the place
// to save, the progress and the report. It loads lazily, as its own
// chunk, with the client of the write workers.
//
// Where the copy goes: `showSaveFilePicker` where the browser has it, else
// a streamed download through the service worker. The copy never sits in
// memory, so there is no Blob fallback: without a picker and a service
// worker, the dialog says that this browser cannot save the copy.
//
// The confirmation asks the user to accept a risk (many tools cannot open
// the copy), so it has no primary button, and Cancel has the focus. While
// it shows, the dialog says how much of the archive is stored or barely
// compressed (hint.ts), from the central directory only. When that is
// less than 5% of the archive, the dialog gives the focus back to Cancel, and
// it says that the copy is not likely to be much smaller. It does not say this
// when bytes outside the entries are a large part of the archive (it gives
// that fact), when the copy leaves out rows, while the byte map runs, when the
// map failed, and when a row has no place in the map or has the wrapped mark.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, from, onCleanup, Show } from "solid-js";
import { ExtractProgress, PROGRESS_BYTES, PROGRESS_FLAGS_OFFSET, State } from "../contracts";
import type { ByteMap, RemuxReport, RemuxSink } from "../contracts";
import { downloadWorker, startDownload, watchStart } from "../extract/download";
import { integers } from "../format";
import type { ArchiveSession } from "../session";
import { controls } from "../shell/controls";
import { CutPath } from "../shell/CutPath";
import { dialogStyle } from "../shell/dialog";
import { FileText } from "../shell/FileText";
import { Icon } from "../shell/icons";
import { color } from "../theme/tokens.stylex";
import { startRemux } from "../write/client";
import { countRows, outsideBytes } from "./hint";
import type { Counts } from "./hint";
import {
  COMPATIBILITY_BODY,
  COMPATIBILITY_LEAD,
  NOT_LIKELY,
  REMUX_NOTE,
  against,
  LARGER_LEAD,
  muchLarger,
  remuxLead,
  notSmaller,
  remuxHintText,
  remuxFacts,
  remuxFileName,
  remuxItemText,
  remuxProgressText,
  remuxSummary,
  remuxSummaryParts,
  remuxTsv,
} from "./text";
import { nameLabel, nameTitle } from "../label";

/** The report rows that the dialog shows. "Copy report" copies all. */
const SHOWN_ITEMS = 500;

interface SavePicker {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    id?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "running"; starting: boolean; workers: number }
  | { kind: "done"; report: RemuxReport; sink: "file" | "stream" }
  | { kind: "error"; message: string };

interface Progress {
  bytes: number;
  total: number;
  rows: number;
  totalRows: number;
}

export interface RemuxDialogProps {
  session: ArchiveSession;
  /** The window of the dialog and the picker. */
  view: Window;
  onClose: () => void;
  /** Called with true while the copy runs. */
  onBusy: (busy: boolean) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const named = (error: unknown, ...names: string[]) =>
  error instanceof DOMException && names.includes(error.name);

export default function RemuxDialog(props: RemuxDialogProps) {
  const session = props.session;
  const view = props.view;
  const picker = view as unknown as SavePicker;
  const name = remuxFileName(session.info.name);
  const facts = {
    rows: session.reader.visibleRows(),
    complete: session.reader.state() === State.COMPLETE,
  };
  const factsText = () => {
    const now = counts();
    return now === undefined
      ? remuxFacts(facts.rows)
      : remuxFacts(facts.rows, now.bytes, now.leftOut, now.wrapped);
  };
  const counts = createMemo(() =>
    from<Counts | undefined>((emit) => {
      let live = true;
      // A read of a source with no value holds the commit, so the dialog opens
      // with no value and does not wait.
      emit(undefined);
      void countRows(session.reader, facts.rows, () => live).then((value) => {
        if (live && value !== undefined) emit(value);
      });
      return () => {
        live = false;
      };
    }),
  );
  // The byte map of the Archive panel: the panel asked for it, the button of
  // this dialog is in the panel, and the worker keeps the result. Until it
  // comes, and if it fails, the dialog has no bytes outside the entries. The
  // first value is undefined, as for the count, so the dialog does not wait.
  const map = createMemo(() =>
    from<ByteMap | undefined>((emit) => {
      let live = true;
      emit(undefined);
      if (facts.complete) {
        session.read.layout().then(
          (value) => {
            if (live) emit(value.map);
          },
          () => {},
        );
      }
      return () => {
        live = false;
      };
    }),
  );
  /** A size field of a row with the mark can hold only the low 32 bits of its
   *  size. A gap can then hold the data of that row, so with such a row the
   *  dialog does not give this value. */
  const outside = () => {
    const known = map();
    return known === undefined || counts()?.wrapped !== 0 ? undefined : outsideBytes(known);
  };
  const buffer = new SharedArrayBuffer(PROGRESS_BYTES);
  const values = new Float64Array(buffer, 0, 4);
  const flags = new Int32Array(buffer, PROGRESS_FLAGS_OFFSET, 2);
  const [phase, setPhase] = createSignal<Phase>(
    facts.complete
      ? { kind: "confirm" }
      : {
          kind: "error",
          message: "Zipscope can save a zstd copy when the listing is complete.",
        },
  );
  let dialog!: HTMLDialogElement;
  let cancelButton: HTMLButtonElement | undefined;
  let gone = false;

  const hintText = createMemo(() => {
    const now = counts();
    return now === undefined
      ? undefined
      : remuxHintText(now.hint, session.file.size, now.leftOut + now.wrapped, outside());
  });
  // When zstd is not likely to make the entries much smaller, the copy is not
  // worth the risk: Cancel gets the focus back, also when the user moved it
  // while the dialog counted the rows. This is a memo, so the late sentences
  // of the byte map do not run the effect and do not move the focus.
  const lowNow = createMemo(() => hintText()?.low === true && phase().kind === "confirm");
  createEffect(lowNow, (low) => {
    if (low) cancelButton?.focus();
  });

  const cancel = () => Atomics.store(flags, ExtractProgress.CANCEL, 1);
  const close = () => {
    if (phase().kind === "running") cancel();
    props.onClose();
  };
  createEffect(
    () => phase().kind === "running",
    (busy) => {
      props.onBusy(busy);
    },
  );
  onCleanup(() => {
    gone = true;
    props.onBusy(false);
    // The lead aborts the output and the workers stop.
    cancel();
  });

  const fail = (error: unknown) => {
    if (!gone) setPhase({ kind: "error", message: message(error) });
  };

  // A copy that started before the count ended gets the total of the
  // bytes when the count ends. No e2e test covers this effect: the count
  // ends about 100 ms after the dialog opens on 1M rows, and a test that
  // must click Save in that time is not reliable. The text of the line
  // without a total has a unit test (`remuxProgressText`).
  createEffect(
    () => counts()?.bytes,
    (bytes) => {
      if (bytes !== undefined && values[ExtractProgress.TOTAL_BYTES] === 0) {
        values[ExtractProgress.TOTAL_BYTES] = bytes;
      }
    },
  );

  /** Runs the copy to `sink` and resolves with the report. */
  const run = async (sink: RemuxSink): Promise<RemuxReport> => {
    const header = (await session.opened).header;
    values.fill(0);
    flags.fill(0);
    // Before the count ends, the progress counts the rows; the effect
    // below gives the total when the count ends.
    values[ExtractProgress.TOTAL_BYTES] = counts()?.bytes ?? 0;
    values[ExtractProgress.TOTAL_FILES] = facts.rows;
    const started = startRemux({
      file: session.file,
      header,
      rows: facts.rows,
      sink,
      progress: buffer,
      hard: session.hard,
      marks: session.reader.marksColumns(),
    });
    const forget = session.trackRemux(started, cancel);
    setPhase({ kind: "running", starting: sink.kind === "stream", workers: started.workers });
    try {
      return await started.report;
    } finally {
      forget();
    }
  };

  const show = (report: RemuxReport, sink: "file" | "stream") => {
    if (!gone) setPhase({ kind: "done", report, sink });
  };

  /** A streamed download through the service worker. */
  const stream = async () => {
    setPhase({ kind: "running", starting: true, workers: 0 });
    const target = await downloadWorker(view.navigator);
    if (gone) return;
    if (target === undefined) {
      setPhase({
        kind: "error",
        message:
          "This browser cannot stream the copy to disk, and Zipscope does not keep a copy of this size in memory. Use a browser with the File System Access API or with service workers.",
      });
      return;
    }
    const download = startDownload(target, view.document, { name, mime: "application/zip" });
    const start = watchStart(
      download,
      flags,
      () => setPhase((now) => (now.kind === "running" ? { ...now, starting: false } : now)),
      cancel,
    );
    try {
      const report = await run({ kind: "stream", port: download.port });
      if (report.outcome === "cancelled" && !start.started()) {
        fail(new Error("The browser did not start the download. Zipscope cannot save the copy."));
        return;
      }
      show(report, "stream");
    } finally {
      start.stop();
      download.dispose();
    }
  };

  /** Picks the place and starts. Call it from a click: the picker needs a
   *  user activation. */
  const go = async () => {
    try {
      if (picker.showSaveFilePicker === undefined) {
        await stream();
        return;
      }
      const handle = await picker.showSaveFilePicker({
        suggestedName: name,
        id: "zipscope-remux",
        types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }],
      });
      // The archive itself must not be the copy: the copy reads it.
      const picked = await handle.getFile().catch(() => undefined);
      const source = session.file;
      if (
        picked !== undefined &&
        picked.size === source.size &&
        picked.lastModified === source.lastModified &&
        picked.name === source.name &&
        source.size > 0
      ) {
        setPhase({
          kind: "error",
          message: `“${nameLabel(source.name)}” is the archive that the copy reads. Choose a different file.`,
        });
        return;
      }
      show(await run({ kind: "file", handle }), "file");
    } catch (error) {
      if (gone) return;
      if (named(error, "AbortError")) {
        // The user closed the picker.
        setPhase({ kind: "confirm" });
      } else if (named(error, "SecurityError", "NotAllowedError")) {
        setPhase({ kind: "confirm" });
      } else {
        fail(error);
      }
    }
  };

  const progress = createMemo<Progress | undefined>(() => {
    if (phase().kind !== "running") return undefined;
    return from<Progress>((next) => {
      const read = () => {
        next({
          bytes: values[ExtractProgress.BYTES]!,
          total: values[ExtractProgress.TOTAL_BYTES]!,
          rows: values[ExtractProgress.FILES]!,
          totalRows: values[ExtractProgress.TOTAL_FILES]!,
        });
        session.onWriteMemory?.();
      };
      read();
      const timer = setInterval(read, 200);
      return () => clearInterval(timer);
    });
  });

  /** The report is a modal when something needs the attention of the
   *  user: a left-out row, or a copy that did not complete. */
  const modal = createMemo(() => {
    const now = phase();
    if (now.kind === "confirm" || now.kind === "error") return true;
    if (now.kind !== "done") return false;
    return (
      now.report.outcome !== "complete" ||
      now.report.items.length + now.report.more > 0 ||
      notSmaller(now.report, session.file.size)
    );
  });
  createEffect(modal, (open) => {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  const runningPhase = () => {
    const now = phase();
    return now.kind === "running" ? now : undefined;
  };
  const donePhase = () => {
    const now = phase();
    return now.kind === "done" ? now : undefined;
  };
  const errorText = () => {
    const now = phase();
    return now.kind === "error" ? now.message : undefined;
  };
  const percent = () => {
    const now = progress();
    if (now === undefined) return undefined;
    if (now.total > 0) return Math.min(100, Math.floor((now.bytes / now.total) * 100));
    if (now.totalRows > 0) return Math.min(100, Math.floor((now.rows / now.totalRows) * 100));
    return undefined;
  };
  const rowName = (row: number) =>
    row < session.reader.visibleRows() ? session.reader.name(row) : `Row ${row}`;
  const copy = (report: RemuxReport) => {
    view.navigator.clipboard?.writeText(remuxTsv(report, rowName)).catch(() => {});
  };
  const archiveLabel = nameLabel(session.info.name);
  const nameShown = nameLabel(name);
  const title = `Zstd copy of “${archiveLabel}”`;

  return (
    <>
      <dialog
        ref={(el) => (dialog = el)}
        id="remux-dialog"
        aria-labelledby="remux-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        {...stylex.attrs(dialogStyle.frame, controls.fadeIn)}
      >
        <h2 id="remux-title" {...stylex.attrs(dialogStyle.title)}>
          {/* After a complete copy, the title gives the result. */}
          <FileText
            text={(() => {
              const now = phase();
              return now.kind === "done" && now.report.outcome === "complete"
                ? `Saved “${nameShown}”`
                : `Save a zstd copy of “${archiveLabel}”`;
            })()}
          />
        </h2>
        <Show when={phase().kind === "confirm"}>
          <p id="remux-facts" {...stylex.attrs(dialogStyle.text)}>
            {factsText()}
          </p>
          <Show when={hintText()}>
            {(now) => (
              <p
                id="remux-hint"
                role="status"
                data-low={now().low ? "true" : undefined}
                {...stylex.attrs(dialogStyle.text)}
              >
                {/* The estimate is a line of its own: the choice depends on
                    it. The lead of the band is the only bold line here. */}
                {now().low && now().text.endsWith(NOT_LIKELY) ? (
                  <>
                    {now().text.slice(0, -NOT_LIKELY.length)}
                    <span id="remux-estimate" {...stylex.attrs(styles.estimate)}>
                      {NOT_LIKELY}
                    </span>
                  </>
                ) : (
                  now().text
                )}
              </p>
            )}
          </Show>
          <div
            id="remux-warning"
            role="alert"
            {...stylex.attrs(dialogStyle.banner, dialogStyle.nextGroup, dialogStyle.warn)}
          >
            <Icon name="alert" />
            <div {...stylex.attrs(dialogStyle.bannerBody)}>
              <p {...stylex.attrs(dialogStyle.lead)}>{COMPATIBILITY_LEAD}</p>
              <p {...stylex.attrs(dialogStyle.body)}>{COMPATIBILITY_BODY}</p>
            </div>
          </div>
          <p id="remux-where" {...stylex.attrs(dialogStyle.text, dialogStyle.nextGroup)}>
            <FileText
              text={
                picker.showSaveFilePicker !== undefined
                  ? `Choose where to save the copy. The suggested name is “${nameShown}”.`
                  : `The browser downloads the copy, “${nameShown}”.`
              }
            />
          </p>
          <p
            id="remux-note"
            {...stylex.attrs(
              dialogStyle.text,
              dialogStyle.nextGroup,
              dialogStyle.muted,
              dialogStyle.small,
            )}
          >
            {REMUX_NOTE}
          </p>
          <div {...stylex.attrs(dialogStyle.footer, dialogStyle.footerSafe)}>
            <button
              ref={(el) => (cancelButton = el)}
              id="remux-cancel"
              type="button"
              autofocus
              onClick={close}
              {...stylex.attrs(controls.button, dialogStyle.button)}
            >
              Cancel
            </button>
            <button
              id="remux-confirm"
              type="button"
              onClick={() => void go()}
              {...stylex.attrs(controls.button, dialogStyle.button)}
            >
              <Icon name="remux" />
              Save zstd copy
            </button>
          </div>
        </Show>
        <Show when={errorText()}>
          {(text) => (
            <>
              <p
                id="remux-error"
                role="alert"
                {...stylex.attrs(dialogStyle.banner, dialogStyle.crit)}
              >
                <Icon name="failed" />
                <span {...stylex.attrs(dialogStyle.bannerBody)}>{text()}</span>
              </p>
              <div {...stylex.attrs(dialogStyle.footer)}>
                <button
                  id="remux-close"
                  type="button"
                  autofocus
                  onClick={close}
                  {...stylex.attrs(controls.button, dialogStyle.button)}
                >
                  Close
                </button>
              </div>
            </>
          )}
        </Show>
        <Show when={modal() && donePhase()}>
          {(now) => (
            <Report
              name={nameShown}
              archiveBytes={session.file.size}
              outside={outside()}
              report={now().report}
              sink={now().sink}
              rowName={rowName}
              onClose={close}
              onCopy={copy}
            />
          )}
        </Show>
      </dialog>
      <Show when={!modal()}>
        <section id="remux-card" aria-label="Zstd copy" {...stylex.attrs(dialogStyle.card)}>
          <div {...stylex.attrs(dialogStyle.cardHead)}>
            <span
              id="remux-card-title"
              {...stylex.attrs(dialogStyle.cardTitle)}
              title={`Zstd copy of “${nameTitle(session.info.name)}”`}
            >
              {title}
            </span>
            <button
              id="remux-card-close"
              type="button"
              aria-label={runningPhase() === undefined ? "Close" : "Cancel zstd copy"}
              title={runningPhase() === undefined ? "Close" : "Cancel zstd copy"}
              onClick={close}
              {...stylex.attrs(controls.iconButton, controls.focusRing)}
            >
              <Icon name="close" />
            </button>
          </div>
          <div
            id={donePhase() === undefined ? undefined : "remux-report"}
            data-state={donePhase()?.report.outcome}
          >
            <p id="remux-status" role="status" {...stylex.attrs(dialogStyle.cardText)}>
              {runningPhase()?.starting
                ? "Starting the download…"
                : runningPhase() !== undefined
                  ? `Saving the zstd copy… ${percent() === undefined ? "" : `${percent()}%`}`
                  : donePhase() === undefined
                    ? ""
                    : remuxSummary(
                        nameShown,
                        donePhase()!.report,
                        donePhase()!.sink,
                        session.file.size,
                        outside(),
                      )}
            </p>
          </div>
          <Show when={runningPhase()}>
            {(now) => (
              <>
                <progress
                  id="remux-progress"
                  max={100}
                  value={percent() ?? 0}
                  {...stylex.attrs(dialogStyle.progress)}
                />
                <p
                  id="remux-detail"
                  {...stylex.attrs(dialogStyle.cardText, dialogStyle.muted, dialogStyle.small)}
                >
                  {(() => {
                    const progressNow = progress();
                    return progressNow === undefined
                      ? ""
                      : remuxProgressText({ ...progressNow, workers: now().workers });
                  })()}
                </p>
              </>
            )}
          </Show>
        </section>
      </Show>
    </>
  );
}

interface ReportProps {
  name: string;
  /** The size of the archive file: the summary compares the copy with
   *  it. */
  archiveBytes: number;
  /** The bytes outside the entries, when the dialog has the value. */
  outside: number | undefined;
  report: RemuxReport;
  sink: "file" | "stream";
  rowName: (row: number) => string;
  onClose: () => void;
  onCopy: (report: RemuxReport) => void;
}

/** The report: the summary and the rows that the copy left out. */
function Report(props: ReportProps) {
  const shown = () => props.report.items.slice(0, SHOWN_ITEMS);
  const hidden = () => props.report.items.length - shown().length + props.report.more;
  /** A copy that did not complete is crit; a copy with rows left out, or
   *  one that is not smaller than the archive, is warn. */
  const tone = (): "crit" | "warn" | "info" =>
    props.report.outcome !== "complete"
      ? "crit"
      : props.report.items.length + props.report.more > 0 ||
          notSmaller(props.report, props.archiveBytes)
        ? "warn"
        : "info";
  const parts = () =>
    remuxSummaryParts(props.name, props.report, props.sink, props.archiveBytes, props.outside);
  /** A complete copy that is not smaller, with no rows left out: the
   *  success leads in ink, and only the size follows it, as heavy as its
   *  difference. */
  const quietSuccess = () =>
    notSmaller(props.report, props.archiveBytes) &&
    props.report.items.length + props.report.more === 0;
  const size = () => against(props.report.output, props.archiveBytes);
  const complete = () => props.report.outcome === "complete";
  /** The lines below the lead. The title of a complete copy has the file
   *  name, so the lead has only the numbers. */
  const body = () =>
    parts()
      .slice(1)
      .filter((part) => !quietSuccess() || part !== size())
      .join(" ");
  return (
    <div id="remux-report" data-state={props.report.outcome}>
      <div
        id="remux-summary"
        role="status"
        data-tone={tone()}
        {...stylex.attrs(quietSuccess() ? styles.plain : [dialogStyle.banner, dialogStyle[tone()]])}
      >
        <Show when={tone() !== "info" && !quietSuccess()}>
          <Icon name={tone() === "crit" ? "failed" : "alert"} />
        </Show>
        <div {...stylex.attrs(dialogStyle.bannerBody)}>
          <p {...stylex.attrs(dialogStyle.lead)}>
            {complete() ? remuxLead(props.report) : parts()[0]}
          </p>
          <Show when={body() !== ""}>
            <p {...stylex.attrs(dialogStyle.body)}>{body()}</p>
          </Show>
        </div>
        <Show when={quietSuccess()}>
          <Show
            when={muchLarger(props.report, props.archiveBytes)}
            fallback={
              <p {...stylex.attrs(styles.note)}>
                <span {...stylex.attrs(styles.noteIcon)}>
                  <Icon name="alert" />
                </span>
                {size()}
              </p>
            }
          >
            <div {...stylex.attrs(dialogStyle.banner, dialogStyle.warn, styles.band)}>
              <Icon name="alert" />
              <div {...stylex.attrs(dialogStyle.bannerBody)}>
                <p {...stylex.attrs(dialogStyle.lead)}>{LARGER_LEAD}</p>
                <p {...stylex.attrs(dialogStyle.body)}>{size()}</p>
              </div>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={shown().length > 0}>
        {/* It scrolls, so the keys must reach it. */}
        <div
          role="region"
          aria-label="Entries left out"
          tabindex={0}
          {...stylex.attrs(dialogStyle.list, controls.focusRing)}
        >
          <table
            id="remux-items"
            role="table"
            {...stylex.attrs(dialogStyle.table, dialogStyle.stack)}
          >
            <thead {...stylex.attrs(controls.visuallyHidden)}>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody role="rowgroup" {...stylex.attrs(dialogStyle.stack)}>
              <For each={shown()}>
                {(item) => (
                  <tr
                    role="row"
                    data-row={item.row}
                    data-skip={item.skip}
                    {...stylex.attrs(dialogStyle.stack, dialogStyle.stackRow)}
                  >
                    <td
                      role="cell"
                      {...stylex.attrs(dialogStyle.cell, dialogStyle.stack, dialogStyle.stackPath)}
                    >
                      <CutPath path={props.rowName(item.row)} />
                    </td>
                    <td
                      role="cell"
                      {...stylex.attrs(
                        dialogStyle.cell,
                        dialogStyle.stack,
                        dialogStyle.stackReason,
                        item.skip === 12 || item.skip === 14 ? styles.failed : dialogStyle.muted,
                      )}
                    >
                      {remuxItemText(item)}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <Show when={hidden() > 0}>
        <p {...stylex.attrs(dialogStyle.text, dialogStyle.muted, dialogStyle.small)}>
          {`${integers.format(hidden())} more items are not shown. Copy the report to see the listed items.`}
        </p>
      </Show>
      <div {...stylex.attrs(dialogStyle.footer)}>
        <Show when={props.report.items.length > 0}>
          <button
            id="remux-copy"
            type="button"
            onClick={() => props.onCopy(props.report)}
            {...stylex.attrs(controls.button, dialogStyle.button)}
          >
            <Icon name="copy" />
            Copy report
          </button>
        </Show>
        <button
          id="remux-close"
          type="button"
          autofocus
          onClick={() => props.onClose()}
          {...stylex.attrs(controls.button, dialogStyle.button)}
        >
          Close
        </button>
      </div>
    </div>
  );
}

const styles = stylex.create({
  /** The estimate: a line of its own, at the weight of the facts. */
  estimate: {
    display: "block",
    marginBlockStart: 4,
  },
  /** A success in ink, with no band. */
  plain: {
    display: "flex",
    flexDirection: "column",
    paddingBlock: 4,
    paddingInline: 16,
    rowGap: 8,
  },
  /** A difference under 1%: ink text with the warn icon, and no band. */
  note: {
    alignItems: "flex-start",
    columnGap: 8,
    display: "flex",
    margin: 0,
  },
  noteIcon: {
    color: color.warn,
    display: "flex",
    flexShrink: 0,
  },
  /** The band sits in the plain block, which has the inline space. */
  band: {
    marginInline: 0,
  },
  failed: {
    color: color.crit,
  },
});
