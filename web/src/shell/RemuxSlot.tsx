// The zstd remux dialog, from its chunk. The chunk and the
// write wasm load on the first "Save a zstd copy", never on the eager
// path.
import { createMemo, from, Match, Switch } from "solid-js";
import type { ArchiveSession } from "../session";

/** Loads the remux module. */
export function loadRemux() {
  return import("../remux/RemuxDialog");
}

type Chunk =
  | { status: "loading" }
  | { status: "ready"; module: Awaited<ReturnType<typeof loadRemux>> }
  | { status: "failed" };

export interface RemuxSlotProps {
  session: ArchiveSession;
  view: Window;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}

export function RemuxSlot(props: RemuxSlotProps) {
  // As the extraction dialog: an async source, so a failed load stays data.
  const chunk = createMemo(() =>
    from<Chunk>((emit) => {
      emit({ status: "loading" });
      loadRemux().then(
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
        <p id="remux-load-error" role="alert" onClick={() => props.onClose()}>
          The zstd copy could not load. Check the network, then try again.
        </p>
      </Match>
      <Match when={loaded()}>
        {(module) => {
          const RemuxDialog = module().default;
          return (
            <RemuxDialog
              session={props.session}
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
