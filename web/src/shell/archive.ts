// The open archive as the shell shows it: the top bar, the map margin and
// the front door use this one type.

export interface ArchiveInfo {
  /** The file name. */
  name: string;
  /** The file size in bytes. */
  bytes: number;
  /** True for the demo archive of "Try a sample archive". */
  demo: boolean;
}
