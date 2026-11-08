// Use the existing warning API. No new API is assumed.
// The rule per file is `fileNeedsConfirmation` in contracts.ts, which the
// read worker and the dialog use.
// A ratio above 100x needs confirmation only when the file declares at
// least 16 MiB, so the small cases (1 byte with no data, 101 bytes from 1,
// 10,001 bytes from 100) do not need it. The cases at 16 MiB and more check
// the ratio boundary.
import { expect, test } from "vitest";
import { fileNeedsConfirmation } from "../contracts";

test.each([
  [0, 0, false],
  [0, 1, false],
  [1, 0, false],
  [100, 1, false],
  [101, 1, false],
  [10001, 100, false],
  [6042, 10, false],
  [2 ** 24 - 1, 0, false],
  [2 ** 24, 0, true],
  [25 * 2 ** 20, 2 ** 18, false],
  [25 * 2 ** 20 + 1, 2 ** 18, true],
  [20 * 2 ** 20, (20 * 2 ** 20) / 200, true],
  [2 ** 31, 2 ** 30, true],
  [1024 ** 3, 1024 ** 3, false],
  [1024 ** 3 + 1, 1024 ** 3 + 1, true],
  [2 ** 52, 2 ** 52, true],
])("confirmation boundary: size %s, compressed %s", (size, compressed, required) => {
  expect(fileNeedsConfirmation(size, compressed)).toBe(required);
});
