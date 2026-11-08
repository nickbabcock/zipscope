import { expect, test } from "vitest";
import { staleCaches } from "./sw-caches";

test("the first version removes nothing", () => {
  expect(staleCaches(["a"], "a", new Set(["a"]))).toEqual([]);
});

test("an update keeps the cache of the version that was active before", () => {
  expect(staleCaches(["a", "b"], "b", new Set(["a"]))).toEqual([]);
});

test("the next update removes the cache of two versions before", () => {
  expect(staleCaches(["a", "b", "c"], "c", new Set(["a", "b"]))).toEqual(["a"]);
});

test("a version that waited and never activated does not take the place of the active one", () => {
  // b waited, then c came first: the open tabs still use a.
  expect(staleCaches(["a", "b", "c"], "c", new Set(["a"]))).toEqual(["b"]);
});

test("a newer version that installs while this one activates keeps its cache", () => {
  expect(staleCaches(["a", "b", "c"], "b", new Set(["a"]))).toEqual([]);
});

test("a current cache that is not in the list removes nothing", () => {
  expect(staleCaches(["a", "b"], "x", new Set(["a", "b"]))).toEqual([]);
});
