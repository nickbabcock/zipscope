import { FileReaderAt, WindowReaderAt } from "../src/parse/reader";
import { PrefetchReaderAt } from "../bench/reader/strategies";

self.onmessage = async ({ data: file }: MessageEvent<File>) => {
  try {
    for (const kind of ["direct", "sync", "prefetch"]) {
      const sync = new FileReaderSync();
      const reader =
        kind === "direct"
          ? new FileReaderAt(file, sync)
          : kind === "sync"
            ? new WindowReaderAt(file, sync, 1024)
            : new PrefetchReaderAt(file, sync, 1024);
      for (const offset of [
        0,
        1020,
        1024,
        2 ** 32 - 4,
        2 ** 32 + 7,
        file.size - 7,
        file.size,
        file.size + 3,
      ]) {
        for (const length of [0, 17, 2048]) {
          const output = new Uint8Array(length).fill(255);
          const count = reader.readAt(offset, output);
          const expected = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
          if (count < 0 || count > expected.length || (expected.length > 0 && count === 0)) {
            throw new Error(`${kind}: invalid length at ${offset}`);
          }
          for (let i = 0; i < count; i++) {
            if (output[i] !== expected[i]) throw new Error(`${kind}: wrong byte at ${offset + i}`);
          }
          if (output.subarray(count).some((byte) => byte !== 255)) {
            throw new Error(`${kind}: changed bytes after the read`);
          }
          if (reader instanceof PrefetchReaderAt) reader.prefetch();
        }
      }
      if (reader instanceof PrefetchReaderAt) reader.stop();
      else reader.close();
    }
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
