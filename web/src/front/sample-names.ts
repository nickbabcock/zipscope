// The names of the demo archive, and the uses of the sample. This module has
// no generator code, so the app can import it: the generator runs in a worker.

export const SAMPLE_NAME = "demo-app-2.4.0-release.zip";
export const SAMPLE_ROOT = "demo-app-2.4.0";
/** The entry that occurs two times. */
export const SAMPLE_DUPLICATE = `${SAMPLE_ROOT}/share/doc/demo-app/CHANGELOG.md`;
/** The space hog. */
export const SAMPLE_HOG = `${SAMPLE_ROOT}/debug/demo-app.debug`;
/** The bytes after the end record. */
export const SAMPLE_TRAILER_BYTES = 3 * 1024;

/** The controls of the door that open the sample at one place: the root
 *  listing, the preview of the space hog, or the health list. */
export type Answer = "contents" | "preview" | "health";
/** The control that starts the sample. */
export type SampleUse = Answer | "sample";
