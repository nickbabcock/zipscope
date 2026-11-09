// The names of the demo archive, and the uses of the sample. This module has
// no generator code, so the app can import it: the generator runs in a worker.

export const SAMPLE_NAME = "demo-app-2.4.0-release.zip";
export const SAMPLE_ROOT = "demo-app-2.4.0";
/** The entry that occurs two times. */
export const SAMPLE_DUPLICATE = `${SAMPLE_ROOT}/share/doc/demo-app/CHANGELOG.md`;
/** The space hog. */
export const SAMPLE_HOG = `${SAMPLE_ROOT}/debug/demo-app.debug`;
/** The icon of the app: a real picture, for the preview. */
export const SAMPLE_PICTURE = `${SAMPLE_ROOT}/share/demo-app/icons/hicolor/scalable/apps/demo-app.svg`;
/** The row of the picture in the archive. `sample.test.ts` checks it. */
export const SAMPLE_PICTURE_ROW = 12;
/** The bytes after the end record. */
export const SAMPLE_TRAILER_BYTES = 3 * 1024;

/** The "See it" controls of the door that open the sample at one place: the
 *  root listing, the preview of the picture, or the health list. */
export type Answer = "contents" | "preview" | "health";
/** The control that starts the sample. "shot" is the picture of the tool: it
 *  opens the preview of the space hog, as the picture shows it. */
export type SampleUse = Answer | "sample" | "shot";
