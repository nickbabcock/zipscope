// Data for the extraction tests.

/** `length` bytes of text that compress about 4 to 3, from a seed. A
 *  file of 16 MiB or more that compresses more than 100 times needs
 *  confirmation. */
export function text(length: number, seed = "zipscope "): Buffer {
  let state = [...seed].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 7);
  const random = Buffer.alloc(Math.ceil((length * 3) / 4) + 3);
  for (let i = 0; i < random.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    random[i] = state >>> 24;
  }
  return Buffer.from(random.toString("base64").slice(0, length));
}

/** A symbolic link: Unix mode 0o120777, made on Unix. */
export const LINK = { attributes: (0o120777 << 16) >>> 0, madeBy: 0x0314 };
