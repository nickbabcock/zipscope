// Saves a Blob as a download. The extraction uses it for its
// Blob fallback, and the Archive panel for the unaccounted regions, whose
// Blob is a slice of the file and does not sit in memory.

/** Saves a Blob as a download with the last segment of the entry name. */
export function saveBlob(blob: Blob, name: string, doc: Document = document): void {
  const base = name.split(/[/\\]/).findLast((part) => part !== "") ?? "entry";
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = base;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  // The download has the data when the click returns, but some browsers
  // read the URL later.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
