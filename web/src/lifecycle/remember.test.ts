import { expect, test } from "vitest";
import {
  identify,
  KEPT_ARCHIVES,
  rememberArchive,
  rememberedArchive,
  sameArchive,
  TAIL_BYTES,
} from "./remember";

/** A Storage in memory. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

test("the identity has the name, the size and a hash of the tail", async () => {
  const bytes = new Uint8Array(TAIL_BYTES + 10).map((_, index) => index % 251);
  const file = new File([bytes], "a.zip");
  const identity = await identify(file);
  expect(identity.name).toBe("a.zip");
  expect(identity.bytes).toBe(TAIL_BYTES + 10);
  expect(identity.tail).toMatch(/^[0-9a-f]{64}$/);
  expect(sameArchive(identity, await identify(new File([bytes], "a.zip")))).toBe(true);
  // Another name, another size or another tail does not match.
  expect(sameArchive(identity, await identify(new File([bytes], "b.zip")))).toBe(false);
  expect(sameArchive(identity, await identify(new File([bytes.slice(1)], "a.zip")))).toBe(false);
  const changed = bytes.slice();
  changed[changed.length - 1] ^= 1;
  expect(sameArchive(identity, await identify(new File([changed], "a.zip")))).toBe(false);
  // Bytes before the tail are not part of the match.
  const head = bytes.slice();
  head[0] ^= 1;
  expect(sameArchive(identity, await identify(new File([head], "a.zip")))).toBe(true);
  expect(sameArchive(undefined, identity)).toBe(false);
});

test("the tab keeps the newest archives by session", () => {
  const storage = memoryStorage();
  for (let index = 0; index < KEPT_ARCHIVES + 2; index++) {
    rememberArchive(`s${index}`, { name: `${index}.zip`, bytes: index, tail: "ab" }, storage);
  }
  expect(rememberedArchive(`s${KEPT_ARCHIVES + 1}`, storage)).toEqual({
    name: `${KEPT_ARCHIVES + 1}.zip`,
    bytes: KEPT_ARCHIVES + 1,
    tail: "ab",
  });
  expect(Object.keys(JSON.parse(storage.getItem("zipscope:archives")!))).toHaveLength(
    KEPT_ARCHIVES,
  );
});

test("a damaged record is not an archive", () => {
  const storage = memoryStorage();
  storage.setItem("zipscope:archives", "not json");
  expect(rememberedArchive("s", storage)).toBeUndefined();
  storage.setItem("zipscope:archives", JSON.stringify({ s: { name: 1, bytes: "x" } }));
  expect(rememberedArchive("s", storage)).toBeUndefined();
});
