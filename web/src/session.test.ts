import { afterEach, expect, test, vi } from "vitest";
import { HEADER_BYTES } from "./contracts";
import type { MirrorSink, ParseOutcome } from "./contracts";
import { ArchiveSession, JOB_STOP_MS } from "./session";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  finished: vi.fn(),
  list: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock("comlink", () => ({
  wrap: () => ({ open: mocks.open, finished: mocks.finished, list: mocks.list }),
  proxy: (sink: unknown) => sink,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("a terminal worker outcome clears the prompt and rejects late prompts", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      terminate = mocks.terminate;
    },
  );
  const end = Promise.withResolvers<ParseOutcome>();
  let sink!: MirrorSink;
  mocks.open.mockImplementation((_file, nextSink) => {
    sink = nextSink;
    return Promise.resolve({ header: new SharedArrayBuffer(HEADER_BYTES), entriesHint: 10 });
  });
  mocks.finished.mockReturnValue(end.promise);
  const session = new ArchiveSession(new File(["12345"], "archive.zip"), true);
  expect(session.info).toEqual({ name: "archive.zip", bytes: 5, demo: true });
  await session.opened;
  let visible = false;
  const remove = session.onPrompt((prompt) => {
    visible = prompt !== undefined;
  });
  const pending = sink.confirmMemory!({ rows: 2, bytes: 2 ** 30 });
  expect(visible).toBe(true);
  end.resolve({ kind: "failed", rows: 2, message: "memory limit" });
  await session.finished;
  expect(await pending).toBe(false);
  expect(visible).toBe(false);
  expect(await sink.confirmMemory!({ rows: 2, bytes: 2 ** 30 })).toBe(false);
  expect(visible).toBe(false);
  remove();
  session.close();
  expect(mocks.terminate).toHaveBeenCalledOnce();
});

test("a view request calls onPublished when it settles", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      terminate = mocks.terminate;
    },
  );
  mocks.open.mockReturnValue(new Promise(() => {}));
  mocks.finished.mockReturnValue(new Promise(() => {}));
  const session = new ArchiveSession(new File([], "archive.zip"));
  let published = 0;
  session.onPublished = () => published++;
  const done = Promise.withResolvers<void>();
  mocks.list.mockReturnValueOnce(done.promise);
  const listed = session.list(1);
  await Promise.resolve();
  expect(published).toBe(0);
  done.resolve();
  await listed;
  await Promise.resolve();
  expect(published).toBe(1);
  // A request that fails also settles.
  mocks.list.mockReturnValueOnce(Promise.reject(new Error("closed")));
  await expect(session.list(2)).rejects.toThrow("closed");
  await Promise.resolve();
  expect(published).toBe(2);
  session.close();
});

/** A session whose workers are stubs. Each new worker gets a number in
 *  `made`, and `alive` holds the workers that did not stop. */
function stubSession() {
  const alive = new Set<number>();
  let made = 0;
  vi.stubGlobal(
    "Worker",
    class {
      readonly id = made++;
      constructor() {
        alive.add(this.id);
      }
      addEventListener() {}
      terminate() {
        alive.delete(this.id);
      }
    },
  );
  mocks.open.mockReturnValue(new Promise(() => {}));
  mocks.finished.mockReturnValue(new Promise(() => {}));
  return { session: new ArchiveSession(new File(["1"], "archive.zip")), alive };
}

test("close with no job stops the parse worker at once", async () => {
  const { session, alive } = stubSession();
  expect(alive.size).toBe(1);
  await session.close();
  expect(alive.size).toBe(0);
  // A second close does nothing more.
  await session.close();
  expect(alive.size).toBe(0);
});

test("close cancels a job, and the other workers stop when it aborted", async () => {
  const { session, alive } = stubSession();
  const job = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const remux = { stop: vi.fn(), memoryBytes: () => 0, report: job.promise };
  session.trackRemux(remux, cancel);
  expect(session.writing()).toBe(true);
  let closed = false;
  void session.close().then(() => (closed = true));
  // The parse worker stops at once. The job has its cancel and continues.
  expect(alive.size).toBe(0);
  expect(cancel).toHaveBeenCalledOnce();
  expect(remux.stop).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(closed).toBe(false);
  job.resolve();
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(remux.stop).toHaveBeenCalledOnce();
});

test("close stops the workers of a job that does not stop in time", async () => {
  vi.useFakeTimers();
  try {
    const { session } = stubSession();
    const stop = vi.fn();
    session.trackRemux({ stop, memoryBytes: () => 0, report: new Promise(() => {}) }, () => {});
    const cancel = vi.fn();
    session.trackJob({ cancel, settled: new Promise(() => {}) });
    const closed = session.close();
    expect(cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(JOB_STOP_MS - 1);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("with `after`, the parse starts only when the old archive closed", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      addEventListener() {}
      terminate() {}
    },
  );
  mocks.open.mockReturnValue(new Promise(() => {}));
  mocks.finished.mockReturnValue(new Promise(() => {}));
  const closed = Promise.withResolvers<void>();
  const session = new ArchiveSession(new File(["1"], "next.zip"), false, closed.promise);
  await Promise.resolve();
  expect(mocks.open).not.toHaveBeenCalled();
  closed.resolve();
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
  await session.close();
});

test("a session that closes while it waits never starts its parse", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      addEventListener() {}
      terminate() {}
    },
  );
  mocks.finished.mockReturnValue(new Promise(() => {}));
  const closed = Promise.withResolvers<void>();
  const session = new ArchiveSession(new File(["1"], "next.zip"), false, closed.promise);
  await session.close();
  closed.resolve();
  await expect(session.opened).rejects.toThrow("closed");
  expect(mocks.open).not.toHaveBeenCalled();
});

test("a third archive also waits for the workers of the first archive", async () => {
  // A has a job that writes files. B replaces A and waits for A. C
  // replaces B before A stopped: C waits for A too, though B has no job.
  const { session: first } = stubSession();
  const job = Promise.withResolvers<void>();
  first.trackRemux({ stop: vi.fn(), memoryBytes: () => 0, report: job.promise }, () => {});
  const second = new ArchiveSession(new File(["2"], "b.zip"), false, first.closeForNext());
  const after = second.closeForNext();
  expect(after).toBeDefined();
  const third = new ArchiveSession(new File(["3"], "c.zip"), false, after);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The parse of A started; B and C wait.
  expect(mocks.open).toHaveBeenCalledOnce();
  job.resolve();
  // B is closed, so only C starts its parse.
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  expect(mocks.open.mock.calls[1]![0].name).toBe("c.zip");
  await expect(second.opened).rejects.toThrow("closed");
  // C closes with no job and no wait, so the next archive does not wait.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(third.closeForNext()).toBeUndefined();
});
