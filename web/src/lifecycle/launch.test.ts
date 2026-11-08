import { expect, test, vi } from "vitest";
import { LAUNCH_SEARCH, takeLaunch, watchLaunches } from "./launch";
import type { LaunchParams, LaunchQueue } from "./launch";

function fakeHistory() {
  return { state: { kept: 1 }, replaceState: vi.fn() };
}

function fileHandle(name: string, fails = false) {
  return {
    kind: "file",
    name,
    getFile: () =>
      fails ? Promise.reject(new Error("gone")) : Promise.resolve(new File(["PK"], name)),
  } as unknown as FileSystemFileHandle;
}

/** A queue that gives `params` to the consumer when it is set, as the
 *  browser does with a launch that came before. */
function queueOf(params: LaunchParams): LaunchQueue {
  return { setConsumer: (consumer) => consumer(params) };
}

test("the launch mark is taken from the address", () => {
  const history = fakeHistory();
  expect(takeLaunch({ search: LAUNCH_SEARCH }, history)).toBe(true);
  expect(history.replaceState).toHaveBeenCalledWith({ kept: 1 }, "", "/");
});

test("an address without the mark stays", () => {
  const history = fakeHistory();
  expect(takeLaunch({ search: "" }, history)).toBe(false);
  expect(takeLaunch({ search: "?launch=1" }, history)).toBe(false);
  expect(history.replaceState).not.toHaveBeenCalled();
});

test("a launch gives its first file with its handle", async () => {
  const first = fileHandle("a.zip");
  const onFile = vi.fn();
  const onNone = vi.fn();
  const folder = { kind: "directory", name: "x" } as FileSystemHandle;
  watchLaunches(queueOf({ files: [folder, first, fileHandle("b.zip")] }), onFile, onNone);
  await vi.waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));
  const [file, handle] = onFile.mock.calls[0] as [File, FileSystemFileHandle];
  expect(file.name).toBe("a.zip");
  expect(handle).toBe(first);
  expect(onNone).not.toHaveBeenCalled();
});

test("a launch with no file, or a file that cannot be read, ends the wait", async () => {
  const onFile = vi.fn();
  const onNone = vi.fn();
  watchLaunches(queueOf({ files: [] }), onFile, onNone);
  expect(onNone).toHaveBeenCalledTimes(1);
  watchLaunches(queueOf({ files: [fileHandle("a.zip", true)] }), onFile, onNone);
  await vi.waitFor(() => expect(onNone).toHaveBeenCalledTimes(2));
  expect(onFile).not.toHaveBeenCalled();
});

test("a browser without a launch queue does nothing", () => {
  const onNone = vi.fn();
  watchLaunches(undefined, vi.fn(), onNone);
  expect(onNone).not.toHaveBeenCalled();
});
