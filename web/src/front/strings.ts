// All text of the front door, in one module for a later translation.
//
// The app imports `front`. The build imports `door` (see `door-static.ts`)
// and puts its words in the served HTML, so the words do not ship two times.
// A word in backticks is data: the HTML shows it in the mono font. A number in
// double stars leads its answer: the HTML shows it in a heavier weight.

/** The source code of Zipscope. */
export const SOURCE_URL = "https://github.com/nickbabcock/zipscope";

/** The flag of the compact door in `localStorage`. It holds no file name.
 *  `public/door-boot.js` reads the same key. */
export const DOOR_FLAG_KEY = "zipscope.door";

/**
 * Adds the offline line to the answer about the device. The line is true
 * only because the front door preloads the workers and the wasm, and the
 * e2e test `offline.spec.ts` proves it. Set it to false if that test cannot
 * pass.
 */
export const SHOW_OFFLINE_TEST = true;

export const front = {
  /** The line that the script adds after the preload. */
  test: "Load this page, disconnect, then open a file. Zipscope still works.",
  open: "Open a file",
  sample: "Try a sample archive",
  /** The first part of `sample`. Below 380 px only this part shows. */
  sampleShort: "Try a sample",
  /** The text at the end of each answer. */
  see: "See it",
  /** The control of the speed band: it opens the sample at its root. */
  openSample: "Open the sample",
  /** The accessible names of the "See it" controls. */
  seeNames: {
    preview: "See it: the preview of a file in the sample archive",
    health: "See it: the health of the sample archive",
  },
  /** The accessible name of the picture of the tool. It opens the sample. */
  shotName: "Open the sample archive in Zipscope",
  /** The map margin while the device makes the sample. */
  making: "Making the sample archive on this device.",
  /** The map margin when the sample cannot open. */
  sampleFailed: "The sample archive did not open. Try again, or open a file.",

  /** The label of the demo archive, wherever it shows. */
  demo: "Demo",

  /** The map margin while the device is offline and no archive is open, after
   *  the preload. While online, the map margin is empty. */
  offline: "Offline. Zipscope still works.",
  /** The same before the preload is complete: the second sentence is not true
   *  until then. */
  offlineOnly: "Offline.",

  /** The door after Back, and after a reload. */
  returnTo: (name: string) => `Return to ${name}`,
  reopen: "Reopen the file to continue",
  /** Below the reopen heading: why the file must open again. */
  reopenWhy: "The browser does not keep access to a file after a reload.",
  /** The remembered location below the reopen action. */
  reopenPath: (path: string) => `Last folder: ${path}`,
  /** The accessible name of the archive button of the reopen door. */
  reopenName: (name: string) => `Reopen ${name}`,
  reopenSearch: (query: string) => `Last search: “${query}”`,
  /** The kept handle did not give the file: the permission was refused, or
   *  the file is gone. The text is correct for the two cases. The next
   *  click opens the file picker. */
  reopenRefused: "Zipscope cannot read the kept file. Click again to choose it.",

  /** The list of recent archives on the front door (Chromium). */
  recentQuestion: "Open a recent archive?",
  /** What the list keeps. The Clear control follows it. */
  recentNote: "The names of the archives that you open stay in this browser.",
  recentClear: "Clear",
  /** The accessible name of the Clear control. */
  recentClearName: "Clear the recent archives",
  /** A recent archive did not open: the user refused the permission, or
   *  the file is gone. Its row goes. */
  recentLost: (name: string) => `Zipscope cannot read ${name}. It is no longer in the list.`,

  /** The state when the browser cannot run Zipscope. */
  unsupported: "This browser can’t run Zipscope",
  unsupportedIsolation:
    "This page is not cross-origin isolated, so it cannot use shared memory. An embedded page or a proxy can cause this. Open Zipscope directly in its own tab.",
  unsupportedBrowser: "This browser does not have the features that Zipscope needs.",
  supportedBrowsers: "Zipscope runs in Chrome 125, Firefox 147, Safari 26 and later versions.",
  /** The features that the browser does not have. */
  unsupportedMissing: (names: string[]) => `Missing: ${names.join(", ")}.`,
} as const;

/** The copy of the served HTML. */
export const door = {
  /** The visible `h1`: the word mark, then what Zipscope is. */
  mark: "Zipscope",
  tagline: "A zip viewer in your browser.",
  /** In the top bar beside the small word mark. */
  barNote: "Nothing to install. Nothing to upload.",
  lead: "See what is in a zip file and where the space went. You do not unpack it or upload it.",
  /** The line below the picture of the tool: the file types it opens. */
  opens:
    "Opens any zip file, such as a jar, apk, whl, ipa, vsix or docx file, and zip64 files larger than 4\u00a0GiB.",
  /** The line below the picture of the tool. */
  shotLabel: "The sample archive in Zipscope. Select the picture to open it.",
  /** The text equivalent of the picture of the tool. */
  shotAlt:
    "Zipscope with the sample archive open: a folder tree with sizes, a table of the largest files with demo-app.debug selected at 12.0 MiB, a warning that one entry has the same name as another entry, and a hex preview of the selected file.",
  action: {
    fine: "or drop a file anywhere on this page.",
    coarse: "Choose a file on this device. It stays on this device.",
    dragging: "Drop the file to open it.",
    compact: "Drop a zip anywhere on this page.",
  },
  noScript: "Zipscope needs JavaScript and WebAssembly to read a file.",
  /** The five bands. Each `figure` is a measured value or a real value of
   *  the sample archive. */
  fast: {
    figure: "1,000,000",
    unit: "entries listed in 1.2\u00a0s",
    heading: "Huge archives open at once.",
    body: "Zipscope reads only the index at the end of the archive. It does not unpack the files to list them. The first rows show in about 0.1\u00a0s, and you can scroll, sort and search while the list fills in. Zip64 archives larger than 4\u00a0GiB open too.",
    note: "Measured in Chromium on a desktop computer, with a generated archive of 1,000,000 entries.",
  },
  local: {
    figure: "0\u00a0bytes",
    unit: "of your file uploaded",
    heading: "Your file stays on your device.",
    body: "Zipscope is a static site. It has no server that can receive a file, and the page can connect only to its own site. After one visit, it works offline too.",
    link: "Read the source code",
  },
  preview: {
    /** The three views of the preview, one for each line of the datum. */
    views: ["Text.", "Pictures.", "Bytes."],
    heading: "Look inside before you extract.",
    body: "Select a file to see its text, its picture or its bytes. Zipscope reads only that file from the archive, and it writes nothing to your disk.",
  },
  health: {
    counts: "1 warning, 1 notice",
    heading: "It does not trust the archive.",
    body: "Zipscope checks what the archive says about itself. It tells you about duplicate names, entries that overlap, data before or after the entries, zip bombs, and names with hidden characters.",
    sample:
      "In the sample archive: one name is in the archive twice, and 3.0\u00a0KiB of data is after the end.",
  },
  save: {
    figure: "zstd",
    unit: "a copy of the archive, each entry checked",
    from: "demo-app-2.4.0-release.zip",
    to: "demo-app-2.4.0-release-zstd.zip",
    heading: "Take files out, or repack them all.",
    body: "Save one file or a whole folder to your disk. Or save a copy of the archive with Zstandard compression. Zipscope checks each entry before it goes into the copy.",
    note: "Many unzip tools cannot open Zstandard entries.",
  },
  /** The heading of the questions. */
  questions: "Questions",
  /** The key names in the keyboard answer. The HTML shows each one as a key
   *  hint (`<kbd>`). */
  keys: ["Enter", "Space", "Escape", "Backspace", "/"],
  files: {
    question: "Which files does it open?",
    answer:
      "Zipscope is a zip viewer for the zip family: .zip, .jar, .apk, .docx, .whl, .vsix and .ipa files, because all of them are zip files. Also zip64 archives larger than 4\u00a0GiB. It does not open 7z, rar or tar files.",
  },
  reads: {
    question: "How does it read a large archive?",
    answer:
      "Zipscope reads the central directory: the list of entries at the end of the file. It does not unpack the archive to list it. `unzip -l` prints the same list with one total, so it does not tell you which folder takes the space. The list fills in as it reads, so you can scroll, search and sort before it ends. At a memory limit, it stops and asks before it goes on.",
  },
  inside: {
    question: "Which entries can it preview?",
    answer:
      "The preview shows stored, Deflate and Zstandard entries. Encrypted entries are listed and labeled, but Zipscope does not decrypt them.",
  },
  device: {
    question: "Does my file leave this device?",
    answer:
      "No. Zipscope is a static site, with no server that can receive a file. The page reads the file in your browser, and its Content Security Policy (`default-src 'self'`) lets it connect only to its own origin. When you save a file to your disk, your browser’s own download check may send its name, hash and other details to a service such as Google Safe Browsing, as it does for other downloads. The page loads no third-party scripts. The source code is MIT licensed, so you can examine this: ",
    link: "github.com/nickbabcock/zipscope",
  },
  keyboard: {
    question: "Can I use only the keyboard?",
    answer:
      "Yes. The arrow keys move in the tree and in the table. Enter opens a folder or the preview of a file, Space shows or hides the preview, Escape closes it, and Backspace goes up one folder. / moves to the search field, and Escape clears it.",
  },
  close: "What is in your zip?",
  /** The footer. */
  footer: "Zipscope is free and open source, under the MIT license.",
  footerSource: "Source code",
} as const;
