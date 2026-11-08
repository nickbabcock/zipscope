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
  /** The accessible names of the "See it" controls. */
  seeNames: {
    contents: "See it: what is in the sample archive",
    space: "See it: where the space of the sample archive went",
    health: "See it: the health of the sample archive",
  },
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
  heading: "Zipscope: a zip viewer that answers three questions about your file",
  /** Beside the word mark: what Zipscope is. */
  tagline: "A zip viewer in your browser.",
  /** One line above all three answers. */
  demoLabel: "These answers are for a sample archive, `demo-app-2.4.0-release.zip`.",
  /** Hidden text at the start of each answer, so a visitor who jumps to a
   *  heading hears that the answer is for the sample. */
  samplePrefix: "In the sample archive: ",
  contents: {
    question: "What is in this zip?",
    answer: "**879 entries** in five folders: `bin`, `lib`, `debug`, `config` and `share`.",
  },
  space: {
    question: "Where did the space go?",
    answer: "`debug/demo-app.debug` is **12.0\u00a0MiB** of the 18.8\u00a0MiB.",
    share: "64%",
    /** The accessible name of the bar. */
    shareName: "64% of the unpacked size",
    /** Real rows of the sample, as the tool lists them. A unit test computes
     *  each value from the sample. `share` is the percent of the unpacked
     *  size, for the bar. */
    rowsLabel: "Largest folders",
    rows: [
      { name: "debug/", size: "12.2\u00a0MiB", share: 65 },
      { name: "share/", size: "4.6\u00a0MiB", share: 25 },
      { name: "bin/", size: "1.1\u00a0MiB", share: 6 },
    ],
  },
  health: {
    question: "Is it healthy?",
    counts: "1 warning, 1 notice.",
    answer: "One name is in the archive twice, and **3.0\u00a0KiB** of data is after the end.",
  },
  action: {
    fine: "Drop your zip, jar, apk, whl, vsix or docx here to get these answers.",
    coarse: "Open your zip, jar, apk, whl, vsix or docx to get these answers.",
    dragging: "Drop the file to get its answers.",
    compact: "Drop a zip anywhere on this page.",
  },
  noScript: "Zipscope needs JavaScript and WebAssembly to read a file.",
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
  lies: {
    question: "What if the archive lies?",
    answer:
      "Zipscope does not trust what an archive says about itself. It tells you what it found, for example duplicate names, entries that overlap, and data before or after the entries.",
  },
  inside: {
    question: "Can I look inside a file?",
    answer:
      "Yes. The preview shows stored, Deflate and Zstandard entries. You can extract a file or a folder to your disk. Encrypted entries are listed and labeled, but Zipscope does not decrypt them.",
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
  /** One answer for each file type, for search. Each claim was checked against
   *  a real file of the type. */
  formats: [
    {
      question: "What is in a .jar file?",
      answer:
        "A Java archive holds compiled `.class` files, resources and `META-INF/MANIFEST.MF`. A fat or shaded jar also holds its dependencies, so look in the package folders for a library that you did not expect.",
    },
    {
      question: "What is in an .apk file?",
      answer:
        "An Android package holds `AndroidManifest.xml`, `classes.dex`, `resources.arsc` and `res/`. Many also hold `assets/` and native libraries in `lib/`, one folder for each processor type. Check `lib/` for a processor type that your users do not need.",
    },
    {
      question: "What is in a .whl file?",
      answer:
        "A Python wheel holds the package folders and a `.dist-info` folder. Open it to see what `pip install` puts on a machine, and whether the tests or large data files shipped.",
    },
    {
      question: "What is in a .vsix file?",
      answer:
        "A Visual Studio Code extension holds an `extension/` folder, `extension.vsixmanifest` and `[Content_Types].xml`. Did `node_modules` ship in this extension? Look in `extension/`, and look for source maps too.",
    },
    {
      question: "What is in a .docx file?",
      answer:
        "A Word document holds XML in `word/`, and each embedded picture in `word/media/`. Sort by size to see which picture makes the document large.",
    },
    {
      question: "What is in an .ipa file?",
      answer:
        "An iOS app holds a `Payload/` folder with the app folder in it. That folder has the executable and the resources. Check `Frameworks/` and `PlugIns/` to see which of them makes the app large.",
    },
  ],
  close: "What is in your zip?",
} as const;
