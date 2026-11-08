import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractProgress } from "../contracts";
import { watchStart } from "./download";

describe("watchStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A watch with a start that the test gives. */
  function watch() {
    let tell = () => {};
    const started = new Promise<void>((resolve) => {
      tell = resolve;
    });
    const flags = new Int32Array(2);
    const onStart = vi.fn();
    const onLimit = vi.fn();
    return {
      tell,
      flags,
      onStart,
      onLimit,
      watch: watchStart({ started }, flags, onStart, onLimit),
    };
  }

  it("goes to the limit at 10 s and not before", async () => {
    const t = watch();
    await vi.advanceTimersByTimeAsync(9_900);
    expect(t.onLimit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(t.onLimit).toHaveBeenCalledOnce();
    expect(t.onStart).not.toHaveBeenCalled();
    expect(t.watch.started()).toBe(false);
  });

  it("knows the start from the service worker at once, and has no limit after it", async () => {
    const t = watch();
    t.tell();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onStart).toHaveBeenCalledOnce();
    expect(t.watch.started()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.onLimit).not.toHaveBeenCalled();
    expect(t.onStart).toHaveBeenCalledOnce();
  });

  it("knows the start from the flag of the job, for an older service worker", async () => {
    const t = watch();
    t.flags[ExtractProgress.STARTED] = 1;
    expect(t.watch.started()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.onStart).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.onLimit).not.toHaveBeenCalled();
  });

  it("does not count a start after the limit, because the limit stopped the job", async () => {
    const t = watch();
    await vi.advanceTimersByTimeAsync(10_000);
    t.tell();
    t.flags[ExtractProgress.STARTED] = 1;
    await vi.advanceTimersByTimeAsync(100);
    expect(t.onStart).not.toHaveBeenCalled();
    expect(t.watch.started()).toBe(false);
  });

  it("does nothing after a stop", async () => {
    const t = watch();
    t.watch.stop();
    t.tell();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.onStart).not.toHaveBeenCalled();
    expect(t.onLimit).not.toHaveBeenCalled();
  });
});
