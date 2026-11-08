// Make small ZIP files. Keep all offsets absolute after a prefix is added.
import { storedZip } from "./stored-zip";

export interface PanelEntry {
  name: string;
  body: Buffer;
  size?: number;
  method?: number;
  flags?: number;
  madeBy?: number;
}

export interface PanelZipOptions {
  prelude?: Buffer;
  gap?: Buffer;
  comment?: Buffer;
  epilogue?: Buffer;
  declared?: number;
}

export function panelZip(entries: PanelEntry[], options: PanelZipOptions = {}) {
  const prelude = options.prelude ?? Buffer.alloc(0);
  const gap = options.gap ?? Buffer.alloc(0);
  const comment = options.comment ?? Buffer.alloc(0);
  const epilogue = options.epilogue ?? Buffer.alloc(0);
  const original = storedZip(entries.map((entry) => [entry.name, entry.body.length]));
  const eocd = original.length - 22;
  const cd = original.readUInt32LE(eocd + 16);
  const locals = Buffer.from(original.subarray(0, cd));
  const central = Buffer.from(original.subarray(cd, eocd));
  const end = Buffer.from(original.subarray(eocd));
  let record = 0;
  for (const entry of entries) {
    const offset = central.readUInt32LE(record + 42);
    const nameLength = central.readUInt16LE(record + 28);
    entry.body.copy(locals, offset + 30 + nameLength);
    locals.writeUInt16LE(entry.method ?? 0, offset + 8);
    locals.writeUInt16LE(entry.flags ?? 0, offset + 6);
    central.writeUInt32LE(offset + prelude.length, record + 42);
    central.writeUInt32LE(entry.size ?? entry.body.length, record + 24);
    central.writeUInt16LE(entry.method ?? 0, record + 10);
    central.writeUInt16LE(entry.flags ?? 0, record + 8);
    central.writeUInt16LE(entry.madeBy ?? 0x031e, record + 4);
    record += 46 + nameLength;
  }
  end.writeUInt32LE(prelude.length + locals.length + gap.length, 16);
  end.writeUInt16LE(comment.length, 20);
  if (options.declared !== undefined) {
    end.writeUInt16LE(options.declared, 8);
    end.writeUInt16LE(options.declared, 10);
  }
  return {
    bytes: Buffer.concat([prelude, locals, gap, central, end, comment, epilogue]),
    ranges: {
      prelude: { offset: 0, bytes: prelude },
      gap: { offset: prelude.length + locals.length, bytes: gap },
      epilogue: {
        offset:
          prelude.length +
          locals.length +
          gap.length +
          central.length +
          end.length +
          comment.length,
        bytes: epilogue,
      },
    },
  };
}
