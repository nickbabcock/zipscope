import { expect, test } from "vitest";
import { checkSupport, missingFeatures } from "./support";

/** A global scope with the features of a browser at the floor. */
function scope(patch: Record<string, unknown> = {}): typeof globalThis {
  return {
    crossOriginIsolated: true,
    SharedArrayBuffer,
    CSS: { supports: (query: string) => query.startsWith("anchor-name") },
    CompressionStream,
    ...patch,
  } as unknown as typeof globalThis;
}

test("a browser at the floor can run Zipscope", () => {
  expect(checkSupport(scope())).toBe("ok");
});

test("a page that is not cross-origin isolated cannot run Zipscope", () => {
  expect(checkSupport(scope({ crossOriginIsolated: false }))).toBe("isolation");
});

test("a browser below the floor cannot run Zipscope", () => {
  expect(checkSupport(scope({ CSS: { supports: () => false } }))).toBe("browser");
  expect(checkSupport(scope({ CSS: undefined }))).toBe("browser");
  expect(checkSupport(scope({ SharedArrayBuffer: undefined }))).toBe("browser");
  expect(checkSupport(scope({ CompressionStream: undefined }))).toBe("browser");
});

test("the unsupported page can name each missing feature", () => {
  expect(missingFeatures(scope())).toEqual([]);
  expect(missingFeatures(scope({ CSS: undefined, CompressionStream: undefined }))).toEqual([
    "CSS anchor positioning",
    "CompressionStream",
  ]);
});
