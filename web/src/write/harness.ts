// Test helpers for the write workers with the real write wasm. The
// lead and the encoders of a test run in one Node process, so
// they share one wasm instance; each test file gets its own instance.
import { vi } from "vitest";
import { PROGRESS_BYTES, WRITE_SLOTS_PER_WORKER } from "../contracts";
import type { EncoderWorkerApi, LeadWorkerApi, RemuxReport, RemuxSink } from "../contracts";
import { BytesFile } from "../read/wasm-harness";

/** A file handle whose writable keeps the bytes, and an aborted flag. */
export function memoryHandle() {
  const state = { parts: [] as Uint8Array[], closed: false, aborted: false };
  const handle = {
    async createWritable() {
      return {
        async write(bytes: Uint8Array) {
          state.parts.push(bytes.slice());
        },
        async close() {
          state.closed = true;
        },
        async abort() {
          state.aborted = true;
          state.parts = [];
        },
      };
    },
  };
  const bytes = () => {
    const out = new Uint8Array(state.parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of state.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  return { handle: handle as unknown as FileSystemFileHandle, state, bytes };
}

let loaded: { lead: LeadWorkerApi; encoder: EncoderWorkerApi } | undefined;

/** Loads the worker modules one time: a module runs once in a file. */
export async function workers(expose: ReturnType<typeof vi.fn>) {
  if (loaded === undefined) {
    expose.mockClear();
    // Paths in variables, so that the type check does not follow the
    // worker modules (they have their own project).
    const leadPath = "./lead";
    const encoderPath = "./encoder";
    await import(leadPath);
    await import(encoderPath);
    loaded = {
      lead: expose.mock.calls[0]![0] as LeadWorkerApi,
      encoder: expose.mock.calls[1]![0] as EncoderWorkerApi,
    };
  }
  return loaded;
}

/** A test can set `before`: the stubbed reader calls it before each read of
 *  the file, with the part of the file that it reads. It can count the read,
 *  or throw to make the read fail. */
export const readHook: { before?: (file: BytesFile) => void } = {};

/** Stubs `FileReaderSync` for the readers of the workers. */
export function stubReader() {
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(file: BytesFile) {
        readHook.before?.(file);
        return file.bytes.slice().buffer;
      }
    },
  );
}

/** Loads the lead and `workers` encoders, and runs a remux of `bytes` (or
 *  of a stub file) with `rows` rows to `sink`. `expose` is the mock of
 *  `Comlink.expose`. */
export async function runRemux(
  expose: ReturnType<typeof vi.fn>,
  bytes: Uint8Array | File,
  header: SharedArrayBuffer,
  rows: number,
  sink: RemuxSink,
  count: number,
  hard: number,
  marks?: Uint8Array[],
): Promise<{ report: RemuxReport; slots: SharedArrayBuffer }> {
  stubReader();
  const { lead, encoder } = await workers(expose);
  const file = bytes instanceof Uint8Array ? (new BytesFile(bytes) as unknown as File) : bytes;
  const slots = new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * (count + 1));
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  const ports: MessagePort[] = [];
  for (let index = 0; index < count; index++) {
    const channel = new MessageChannel();
    ports.push(channel.port2);
    await encoder.open(file, header, slots, index + 1, progress, channel.port1, { hard });
  }
  const options = marks === undefined ? { hard } : { hard, marks };
  const report = await lead.run(file, header, slots, rows, sink, progress, ports, options);
  for (const port of ports) port.close();
  return { report, slots };
}

/** The names and the methods of the records of a zip without zip64. */
export function records(zip: Uint8Array): { name: string; method: number; offset: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("No end record");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const found = [];
  for (let index = 0; index < count; index++) {
    const nameLength = view.getUint16(at + 28, true);
    found.push({
      name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return found;
}
