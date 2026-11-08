// The extraction dialog, from its chunk. The chunk loads on
// the first Extract, and the front door preloads it with the workers.
import { createMemo, from, Match, Switch } from "solid-js";
import type { ExtractTarget } from "../contracts";
import type { ArchiveSession } from "../session";

/** An Extract request from the row menu or the preview. */
export interface ExtractRequest {
  target: ExtractTarget;
  /** The entry name or the folder path, for the dialog. */
  label: string;
}

/** Loads the extraction module. */
export function loadExtraction() {
  return import("../extract/ExtractDialog");
}

type Chunk =
  | { status: "loading" }
  | { status: "ready"; module: Awaited<ReturnType<typeof loadExtraction>> }
  | { status: "failed" };

export interface ExtractSlotProps {
  session: ArchiveSession;
  request: ExtractRequest;
  /** The window of the dialog and the pickers: the app or the popup. */
  view: Window;
  onClose: () => void;
  /** Called with true while the plan or the extraction runs. A new
   *  request then waits; after it, a new request replaces the dialog. */
  onBusy: (busy: boolean) => void;
}

export function ExtractSlot(props: ExtractSlotProps) {
  // As the Archive panel: an async source, so a failed load stays data.
  const chunk = createMemo(() =>
    from<Chunk>((emit) => {
      emit({ status: "loading" });
      loadExtraction().then(
        (module) => emit({ status: "ready", module }),
        () => emit({ status: "failed" }),
      );
    }),
  );
  const loaded = () => {
    const now = chunk();
    return now.status === "ready" ? now.module : undefined;
  };
  return (
    <Switch>
      <Match when={chunk().status === "failed"}>
        <p id="extract-load-error" role="alert" onClick={() => props.onClose()}>
          Extraction could not load. Check the network, then try again.
        </p>
      </Match>
      <Match when={loaded()}>
        {(module) => {
          const ExtractDialog = module().default;
          return (
            <ExtractDialog
              session={props.session}
              request={props.request}
              view={props.view}
              onClose={props.onClose}
              onBusy={props.onBusy}
            />
          );
        }}
      </Match>
    </Switch>
  );
}
