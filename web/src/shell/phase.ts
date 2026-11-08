// The parse phase of the open archive, as the status bar shows it.
import { integers } from "../format";

/** Where the parse of the archive is. `progress` is from 0 to 1. */
export type ParsePhase =
  | { kind: "opening" }
  | { kind: "listing"; progress: number }
  | { kind: "paused"; progress: number }
  | { kind: "listed"; ms: number }
  | { kind: "failed"; rows: number; message: string }
  | { kind: "cancelled"; rows: number };

export const OPENING: ParsePhase = { kind: "opening" };

/** True while the parse can still continue: Cancel shows. */
export function isParsing(phase: ParsePhase): boolean {
  return phase.kind === "opening" || phase.kind === "listing" || phase.kind === "paused";
}

/** The parse progress from 0 to 1, for the progress bar. */
export function phaseProgress(phase: ParsePhase): number {
  return phase.kind === "listing" || phase.kind === "paused" ? phase.progress : 0;
}

/** The status text of a phase. */
export function phaseText(phase: ParsePhase): string {
  const percent = (progress: number) => `${Math.floor(progress * 100)}%`;
  switch (phase.kind) {
    case "opening":
      return "Opening";
    case "listing":
      return `Listing ${percent(phase.progress)}`;
    case "paused":
      return "Paused";
    case "listed":
      return `Listed in ${integers.format(Math.round(phase.ms))} ms`;
    case "failed":
      return phase.rows === 0
        ? `Cannot open: ${phase.message}`
        : `Stopped after ${integers.format(phase.rows)} entries: ${phase.message}`;
    case "cancelled":
      return `Cancelled after ${integers.format(phase.rows)} entries`;
  }
}
