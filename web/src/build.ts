// Facts about this build of the app.

/** Vite replaces this name with a string (see `buildSha` in
 *  vite.config.ts). */
declare const __ZIPSCOPE_BUILD_SHA__: string;

/** The git commit of this build: 12 hex digits, or "unknown". */
export const BUILD_SHA: string = __ZIPSCOPE_BUILD_SHA__;
