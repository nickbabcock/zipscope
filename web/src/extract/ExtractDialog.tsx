// The extraction dialog: the plan and its confirmation, the
// place to write, the progress and the report. It loads lazily, as its
// own chunk.
//
// Where the files go:
// - One entry: `showSaveFilePicker` where the browser has it, else a
//   streamed download through the service worker, else (no service
//   worker, or the stream does not start) a Blob with a size warning.
// - A folder: `showDirectoryPicker` where the browser has it, else one
//   zip that the read worker builds, as a streamed download, else a Blob.
//
// The read worker does all decoding and writing. The dialog only gives it
// the place and reads the progress buffer.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, from, onCleanup, Show } from "solid-js";
import { ExtractProgress, PROGRESS_BYTES, PROGRESS_FLAGS_OFFSET } from "../contracts";
import type { ExtractPlanInfo, ExtractReport, ExtractSink } from "../contracts";
import { formatSize, integers } from "../format";
import { saveBlob } from "../preview/extract";
import type { ArchiveSession } from "../session";
import { controls } from "../shell/controls";
import { dialogStyle } from "../shell/dialog";
import { CutPath } from "../shell/CutPath";
import { FileText } from "../shell/FileText";
import type { ExtractRequest } from "../shell/ExtractSlot";
import { Icon } from "../shell/icons";
import { color } from "../theme/tokens.stylex";
import { downloadWorker, startDownload, watchStart } from "./download";
import {
  itemCounts,
  itemLead,
  itemOutcome,
  itemReason,
  itemStatus,
  OUTCOMES,
  planFacts,
  planNote,
  reportTitle,
  reportTsv,
  SAFEGUARD,
  summary,
  warnings,
} from "./text";
import { nameLabel, nameTitle } from "../label";

/** The report rows that the dialog shows. "Copy report" copies all. */
const SHOWN_ITEMS = 500;

/** The File System Access pickers. Only Chromium has them. */
interface Pickers {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    id?: string;
  }) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

type Phase =
  | { kind: "planning" }
  /** The user confirms, or chooses the place (a picker needs a click). */
  | { kind: "confirm"; plan: ExtractPlanInfo }
  /** The stream did not start: ask before a Blob in memory. */
  | { kind: "memory"; plan: ExtractPlanInfo }
  | { kind: "running"; plan: ExtractPlanInfo; starting: boolean }
  | { kind: "done"; plan: ExtractPlanInfo; report: ExtractReport }
  | { kind: "error"; message: string };

interface Progress {
  bytes: number;
  total: number;
  files: number;
  totalFiles: number;
}

export interface ExtractDialogProps {
  session: ArchiveSession;
  request: ExtractRequest;
  view: Window;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const named = (error: unknown, ...names: string[]) =>
  error instanceof DOMException && names.includes(error.name);

/** The name of the output: the entry, or the zip of a folder. */
const outputName = (plan: ExtractPlanInfo, zip: boolean) =>
  zip && plan.target.kind === "folder" ? `${plan.name}.zip` : plan.name;

export default function ExtractDialog(props: ExtractDialogProps) {
  const session = props.session;
  const view = props.view;
  const pickers = view as unknown as Pickers;
  const [phase, setPhase] = createSignal<Phase>({ kind: "planning" });
  const buffer = new SharedArrayBuffer(PROGRESS_BYTES);
  const values = new Float64Array(buffer, 0, 4);
  const flags = new Int32Array(buffer, PROGRESS_FLAGS_OFFSET, 2);
  let dialog!: HTMLDialogElement;
  /** True after the dialog went. A late answer then does nothing. */
  let gone = false;
  /** The plan that the worker keeps, until `extract` takes it. */
  let kept: number | undefined;

  const close = () => {
    if (phase().kind === "running") {
      Atomics.store(flags, ExtractProgress.CANCEL, 1);
    }
    props.onClose();
  };
  createEffect(
    () => phase().kind === "planning" || phase().kind === "running",
    // An effect may return only a cleanup, so the callback gets a block.
    (busy) => {
      props.onBusy(busy);
    },
  );
  onCleanup(() => {
    gone = true;
    props.onBusy(false);
    Atomics.store(flags, ExtractProgress.CANCEL, 1);
    if (kept !== undefined) session.read.dropPlan(kept);
  });

  const fail = (error: unknown) => {
    if (!gone) setPhase({ kind: "error", message: message(error) });
  };

  const plan = async (): Promise<ExtractPlanInfo> => {
    const info = await session.read.plan(props.request.target);
    kept = info.id;
    if (gone) session.read.dropPlan(info.id);
    return info;
  };

  /** Writes the plan to `sink` and shows the report. */
  const run = async (info: ExtractPlanInfo, sink: ExtractSink): Promise<ExtractReport> => {
    values.fill(0);
    flags.fill(0);
    setPhase({ kind: "running", plan: info, starting: sink.kind === "stream" });
    kept = undefined;
    const result = session.read.extract(info.id, sink, buffer);
    // When the archive closes, it cancels the job and waits for the abort.
    const forget = session.trackJob({
      cancel: () => Atomics.store(flags, ExtractProgress.CANCEL, 1),
      settled: result,
    });
    result.then(forget, forget);
    return result;
  };

  const show = (info: ExtractPlanInfo, report: ExtractReport, zip: boolean) => {
    if (gone) return;
    if (report.blob !== undefined) {
      saveBlob(report.blob, outputName(info, zip), view.document);
    }
    setPhase({ kind: "done", plan: info, report });
  };

  /** A streamed download through the service worker, or the Blob
   *  question when the stream cannot start. */
  const stream = async (info: ExtractPlanInfo) => {
    const zip = info.target.kind === "folder";
    setPhase({ kind: "running", plan: info, starting: true });
    const target = await downloadWorker(view.navigator);
    if (gone) return;
    if (target === undefined) {
      setPhase({ kind: "memory", plan: info });
      return;
    }
    const download = startDownload(target, view.document, {
      name: outputName(info, zip),
      ...(zip ? {} : { length: info.bytes }),
      mime: zip ? "application/zip" : "application/octet-stream",
    });
    const result = run(info, { kind: "stream", port: download.port });
    // The stream starts when the browser asks for the first bytes. When
    // it does not ask in time, the browser cannot stream this download.
    const start = watchStart(
      download,
      flags,
      () => setPhase((now) => (now.kind === "running" ? { ...now, starting: false } : now)),
      () => Atomics.store(flags, ExtractProgress.CANCEL, 1),
    );
    try {
      const report = await result;
      start.stop();
      // A job that failed shows its report, also when the download did
      // not ask for bytes yet; only a stream that never started goes to
      // memory.
      if (report.outcome === "cancelled" && !start.started() && !gone) {
        // The stream never started: the next plan goes to memory.
        setPhase({ kind: "memory", plan: await plan() });
        return;
      }
      show(info, report, zip);
    } finally {
      start.stop();
      download.dispose();
    }
  };

  /** Picks the place and starts. Call it from a click: the pickers need
   *  a user activation. */
  const go = async (info: ExtractPlanInfo, confirmed: boolean) => {
    try {
      if (info.target.kind === "entry") {
        if (info.files > 0 && pickers.showSaveFilePicker !== undefined) {
          const handle = await pickers.showSaveFilePicker({ suggestedName: info.name });
          show(info, await run(info, { kind: "file", handle }), false);
        } else if (info.files === 0) {
          // The plan skipped the entry: the report tells why.
          show(info, await run(info, { kind: "blob" }), false);
        } else {
          await stream(info);
        }
        return;
      }
      if (pickers.showDirectoryPicker !== undefined) {
        const handle = await pickers.showDirectoryPicker({
          id: "zipscope-extract",
          mode: "readwrite",
        });
        show(info, await run(info, { kind: "directory", handle, name: info.name }), false);
      } else if (info.zipError !== undefined) {
        setPhase({ kind: "error", message: info.zipError });
      } else {
        await stream(info);
      }
    } catch (error) {
      if (gone) return;
      if (named(error, "AbortError")) {
        // The user closed the picker.
        if (confirmed) setPhase({ kind: "confirm", plan: info });
        else props.onClose();
      } else if (named(error, "SecurityError", "NotAllowedError")) {
        // The picker needs a click: the first one was too long ago.
        setPhase({ kind: "confirm", plan: info });
      } else {
        fail(error);
      }
    }
  };

  const toMemory = async (info: ExtractPlanInfo) => {
    try {
      show(info, await run(info, { kind: "blob" }), info.target.kind === "folder");
    } catch (error) {
      fail(error);
    }
  };

  plan().then((info) => {
    if (gone) return;
    // A folder always shows its plan first. An entry asks only when its
    // declared size or ratio is suspicious.
    if (info.target.kind === "folder" || warnings(info).length > 0) {
      setPhase({ kind: "confirm", plan: info });
    } else {
      void go(info, false);
    }
  }, fail);

  /** The progress while the extraction runs. */
  const progress = createMemo<Progress | undefined>(() => {
    if (phase().kind !== "running") return undefined;
    return from<Progress>((next) => {
      const read = () =>
        next({
          bytes: values[ExtractProgress.BYTES]!,
          total: values[ExtractProgress.TOTAL_BYTES]!,
          files: values[ExtractProgress.FILES]!,
          totalFiles: values[ExtractProgress.TOTAL_FILES]!,
        });
      read();
      const timer = setInterval(read, 200);
      return () => clearInterval(timer);
    });
  });

  const modal = createMemo(() => {
    const kind = phase().kind;
    if (kind === "confirm" || kind === "memory" || kind === "error") return true;
    if (kind !== "done") return false;
    const now = phase() as Extract<Phase, { kind: "done" }>;
    return now.report.outcome !== "complete" || now.report.items.length > 0;
  });
  createEffect(modal, (open) => {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  const confirmPhase = () => {
    const now = phase();
    return now.kind === "confirm" || now.kind === "memory" ? now : undefined;
  };
  const donePhase = () => {
    const now = phase();
    return now.kind === "done" ? now : undefined;
  };
  const runningPhase = () => {
    const now = phase();
    return now.kind === "running" ? now : undefined;
  };
  const errorText = () => {
    const now = phase();
    return now.kind === "error" ? now.message : undefined;
  };
  const percent = () => {
    const now = progress();
    if (now === undefined || now.total <= 0) return undefined;
    return Math.min(100, Math.floor((now.bytes / now.total) * 100));
  };
  const copy = (report: ExtractReport) => {
    view.navigator.clipboard?.writeText(reportTsv(report)).catch(() => {});
  };

  const target = () => props.request.label.replace(/\/$/, "") || "archive";
  const title = () => `Extract “${nameLabel(target())}”`;
  /** The heading of the dialog. A report names its outcome. */
  const heading = () => {
    const now = donePhase();
    return now === undefined ? title() : reportTitle(now.plan, now.report);
  };

  return (
    <>
      <dialog
        ref={(el) => (dialog = el)}
        id="extract-dialog"
        aria-labelledby="extract-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        {...stylex.attrs(dialogStyle.frame, controls.fadeIn)}
      >
        <h2 id="extract-title" {...stylex.attrs(dialogStyle.title)}>
          <FileText text={heading()} />
        </h2>
        <Show when={confirmPhase()}>
          {(now) => {
            const info = () => now().plan;
            const zip = () =>
              info().target.kind === "folder" && pickers.showDirectoryPicker === undefined;
            const found = () => warnings(info());
            /** A large or bomb-like plan: Cancel is the default, and the
             *  confirm button is a plain button. */
            const risky = () => now().kind === "confirm" && found().length > 0;
            return (
              <>
                <p id="extract-facts" {...stylex.attrs(dialogStyle.text, styles.facts)}>
                  {planFacts(info())}
                </p>
                <Show when={planNote(info())}>
                  {(note) => (
                    <p id="extract-note" {...stylex.attrs(dialogStyle.text, dialogStyle.muted)}>
                      {note()}
                    </p>
                  )}
                </Show>
                <Show when={risky()}>
                  {/* A zip bomb is crit, as in the health list; a large
                      plan only is warn. The
                      safeguard belongs to the risk, so it is the last line
                      of the band. */}
                  <div
                    id="extract-warnings"
                    role="alert"
                    data-tone={info().bombs > 0 ? "crit" : "warn"}
                    {...stylex.attrs(
                      dialogStyle.banner,
                      dialogStyle.nextGroup,
                      info().bombs > 0 ? dialogStyle.crit : dialogStyle.warn,
                    )}
                  >
                    <Icon name={info().bombs > 0 ? "failed" : "alert"} />
                    <div {...stylex.attrs(dialogStyle.bannerBody)}>
                      <p {...stylex.attrs(dialogStyle.lead)}>{found()[0]}</p>
                      <Show when={found().length > 1}>
                        <p {...stylex.attrs(dialogStyle.body)}>{found().slice(1).join(" ")}</p>
                      </Show>
                      <p
                        id="extract-safeguard"
                        {...stylex.attrs(dialogStyle.body, styles.safeguard)}
                      >
                        {SAFEGUARD}
                      </p>
                    </div>
                  </div>
                </Show>
                <Show when={now().kind === "memory"}>
                  <div
                    id="extract-memory"
                    role="alert"
                    {...stylex.attrs(dialogStyle.banner, dialogStyle.nextGroup, dialogStyle.warn)}
                  >
                    <Icon name="alert" />
                    <div {...stylex.attrs(dialogStyle.bannerBody)}>
                      <p {...stylex.attrs(dialogStyle.body)}>
                        {`This browser cannot stream the download, so Zipscope keeps ${nameLabel(outputName(info(), info().target.kind === "folder"))} in memory before it saves it: about ${formatSize(info().bytes)}. A large file can stop the tab.`}
                      </p>
                    </div>
                  </div>
                </Show>
                <p id="extract-where" {...stylex.attrs(dialogStyle.text, dialogStyle.nextGroup)}>
                  <FileText
                    text={
                      now().kind === "memory"
                        ? "The browser saves the file when it is complete."
                        : info().target.kind === "entry"
                          ? pickers.showSaveFilePicker !== undefined
                            ? "Choose where to save the file."
                            : "The browser downloads the file."
                          : zip()
                            ? `The browser downloads one zip file, ${nameLabel(info().name)}.zip.`
                            : `Choose a folder. Zipscope makes the folder “${nameLabel(info().name)}” in it.`
                    }
                  />
                </p>
                <div {...stylex.attrs(dialogStyle.footer, risky() && dialogStyle.footerSafe)}>
                  <button
                    id="extract-cancel"
                    type="button"
                    autofocus={risky()}
                    onClick={close}
                    {...stylex.attrs(controls.button, dialogStyle.button)}
                  >
                    Cancel
                  </button>
                  <button
                    id="extract-confirm"
                    type="button"
                    autofocus={!risky()}
                    onClick={() =>
                      now().kind === "memory" ? void toMemory(info()) : void go(info(), true)
                    }
                    {...stylex.attrs(
                      controls.button,
                      dialogStyle.button,
                      risky() ? dialogStyle.risky : controls.primary,
                    )}
                  >
                    <Icon name="download" />
                    {now().kind === "memory"
                      ? "Save from memory"
                      : risky()
                        ? "Extract anyway"
                        : info().target.kind === "entry"
                          ? "Extract"
                          : zip()
                            ? "Download zip"
                            : "Choose folder…"}
                  </button>
                </div>
              </>
            );
          }}
        </Show>
        <Show when={errorText()}>
          {(text) => (
            <>
              <p
                id="extract-error"
                role="alert"
                {...stylex.attrs(dialogStyle.banner, dialogStyle.crit)}
              >
                <Icon name="failed" />
                <span {...stylex.attrs(dialogStyle.bannerBody)}>{text()}</span>
              </p>
              <div {...stylex.attrs(dialogStyle.footer)}>
                <button
                  id="extract-close"
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
            <Report plan={now().plan} report={now().report} onClose={close} onCopy={copy} />
          )}
        </Show>
      </dialog>
      <Show when={!modal() && phase().kind !== "error"}>
        <section id="extract-card" aria-label="Extraction" {...stylex.attrs(dialogStyle.card)}>
          <div {...stylex.attrs(dialogStyle.cardHead)}>
            <span
              id="extract-card-title"
              {...stylex.attrs(dialogStyle.cardTitle)}
              title={`Extract “${nameTitle(target())}”`}
            >
              {title()}
            </span>
            <button
              id="extract-card-close"
              type="button"
              aria-label={runningPhase() === undefined ? "Close" : "Cancel extraction"}
              title={runningPhase() === undefined ? "Close" : "Cancel extraction"}
              onClick={close}
              {...stylex.attrs(controls.iconButton, controls.focusRing)}
            >
              <Icon name="close" />
            </button>
          </div>
          {/* After a clean extraction, the card is the report. */}
          <div
            id={donePhase() === undefined ? undefined : "extraction-report"}
            data-state={donePhase()?.report.outcome}
          >
            <p id="extract-status" role="status" {...stylex.attrs(dialogStyle.cardText)}>
              {phase().kind === "planning"
                ? "Checking the entries…"
                : runningPhase()?.starting
                  ? "Starting the download…"
                  : runningPhase() !== undefined
                    ? `Extracting… ${percent() === undefined ? "" : `${percent()}%`}`
                    : donePhase() === undefined
                      ? ""
                      : summary(donePhase()!.plan, donePhase()!.report)}
            </p>
          </div>
          <Show when={runningPhase()}>
            <progress
              id="extract-progress"
              max={100}
              value={percent() ?? 0}
              {...stylex.attrs(dialogStyle.progress)}
            />
            <p {...stylex.attrs(dialogStyle.cardText, dialogStyle.muted, dialogStyle.small)}>
              {(() => {
                const now = progress();
                if (now === undefined) return "";
                const files =
                  now.totalFiles > 1
                    ? ` · ${integers.format(now.files)} of ${integers.format(now.totalFiles)} files`
                    : "";
                return `${formatSize(now.bytes)} of ${formatSize(now.total)}${files}`;
              })()}
            </p>
          </Show>
        </section>
      </Show>
    </>
  );
}

interface ReportProps {
  plan: ExtractPlanInfo;
  report: ExtractReport;
  onClose: () => void;
  onCopy: (report: ExtractReport) => void;
}

/** The extraction report: the outcome leads, and the items are in groups by
 *  outcome, the most severe first, with one style for each outcome. */
function Report(props: ReportProps) {
  const listed = () => props.report.items.slice(0, SHOWN_ITEMS);
  const hidden = () => props.report.items.length - listed().length + props.report.more;
  /** The tone of the summary. A failed job is crit. A complete job is
   *  warn when a planned file was not written or a listed item failed,
   *  or when the report does not list all items (`more`), because a
   *  hidden item can be a folder that failed. Else it is neutral. The
   *  value is also the `data-tone` value. */
  const tone = (): "crit" | "warn" | "info" => {
    if (props.report.outcome !== "complete") return "crit";
    // Nothing of the plan was written: the job failed for the user, so
    // the summary is crit, as its failed rows.
    if (props.report.written === 0 && props.plan.files > 0) return "crit";
    const failed =
      props.report.written < props.plan.files ||
      props.report.items.some((item) => itemStatus(item) === "failed");
    return failed || props.report.more > 0 ? "warn" : "info";
  };
  return (
    <div id="extraction-report" data-state={props.report.outcome}>
      <div {...stylex.attrs(dialogStyle.banner, dialogStyle[tone()])}>
        <Show when={tone() !== "info"}>
          <Icon name={tone() === "crit" ? "failed" : "alert"} />
        </Show>
        <div {...stylex.attrs(dialogStyle.bannerBody)}>
          <p
            id="extract-summary"
            role="status"
            data-tone={tone()}
            {...stylex.attrs(dialogStyle.lead)}
          >
            {summary(props.plan, props.report)}
          </p>
          <Show when={itemCounts(props.report)}>
            {(text) => (
              <p id="extract-counts" {...stylex.attrs(dialogStyle.body)}>
                {text()}
              </p>
            )}
          </Show>
        </div>
      </div>
      <Show when={listed().length > 0}>
        {/* It scrolls, so the keys must reach it. */}
        <div
          role="region"
          aria-label="Report items"
          tabindex={0}
          {...stylex.attrs(dialogStyle.list, controls.focusRing)}
        >
          <table
            id="extract-report"
            role="table"
            {...stylex.attrs(dialogStyle.table, dialogStyle.stack)}
          >
            {/* The first row spans the two columns, so the columns give the
                widths. */}
            <colgroup>
              <col {...stylex.attrs(styles.pathColumn)} />
              <col />
            </colgroup>
            <thead {...stylex.attrs(controls.visuallyHidden)}>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <For
              each={OUTCOMES.filter((group) =>
                listed().some((item) => itemOutcome(item) === group.key),
              )}
            >
              {(group) => (
                <tbody
                  data-outcome={group.key}
                  role="rowgroup"
                  {...stylex.attrs(dialogStyle.stack)}
                >
                  <tr role="row" {...stylex.attrs(dialogStyle.stack)}>
                    <th
                      scope="rowgroup"
                      colspan="2"
                      role="rowheader"
                      {...stylex.attrs(
                        styles.group,
                        dialogStyle.stack,
                        group.key === "not-written" && styles.failed,
                        group.key === "renamed" && dialogStyle.muted,
                      )}
                    >
                      {group.label}
                    </th>
                  </tr>
                  <For each={listed().filter((item) => itemOutcome(item) === group.key)}>
                    {(item) => (
                      <tr
                        role="row"
                        data-row={item.row}
                        data-status={itemStatus(item)}
                        data-output-path={item.path ?? ""}
                        data-skip={item.skip ?? ""}
                        data-renamed={item.renamed ?? ""}
                        {...stylex.attrs(dialogStyle.stack, dialogStyle.stackRow)}
                      >
                        <td
                          role="cell"
                          {...stylex.attrs(
                            dialogStyle.cell,
                            dialogStyle.stack,
                            dialogStyle.stackPath,
                          )}
                        >
                          <CutPath path={item.name} />
                        </td>
                        <td
                          role="cell"
                          {...stylex.attrs(
                            dialogStyle.cell,
                            styles.reason,
                            dialogStyle.stack,
                            dialogStyle.stackReason,
                          )}
                        >
                          {/* The group gives the verb to the eye. A screen
                              reader in a row hears it here. */}
                          <span {...stylex.attrs(controls.visuallyHidden)}>{itemLead(item)}</span>
                          {itemReason(item)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              )}
            </For>
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
            id="extract-copy"
            type="button"
            onClick={() => props.onCopy(props.report)}
            {...stylex.attrs(controls.button, dialogStyle.button)}
          >
            <Icon name="copy" />
            Copy report
          </button>
        </Show>
        <button
          id="extract-close"
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
  /** The facts are the main line of the plan, with no competition for the
   *  band of a risk. */
  facts: {
    fontWeight: 500,
  },
  /** The label of an outcome group, with space above it. */
  group: {
    color: color.ink,
    fontWeight: 600,
    paddingBlockEnd: 2,
    paddingBlockStart: 8,
    paddingInline: 16,
    textAlign: "start",
  },
  failed: {
    color: color.crit,
  },
  pathColumn: {
    width: "36%",
  },
  /** The safeguard answers the risk, so it has space from it. */
  safeguard: {
    marginBlockStart: 4,
  },
  /** The reason is secondary to the path and to the group. It wraps at full
   *  width: a short last line is better than a narrow column. */
  reason: {
    color: color.inkMuted,
  },
});
