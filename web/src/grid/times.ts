// Which kinds of modified time the listed rows have. A DOS time has no
// time zone. The table marks each DOS time only when the archive mixes
// DOS times and times with a time zone; when all times are DOS times, the
// column header notes it once.
import { TimeKind } from "../contracts";

/** The note of the column header when all times are DOS times. */
export const DOS_NOTE = "No time zone: these are DOS times as written";
/** The id of the card that shows `DOS_NOTE`. */
export const DOS_NOTE_ID = "dos-note";

/** Follows the time kinds of the rows as the listing grows. Rows only get
 *  added, so each row is read one time. */
export class TimeKinds {
  private scanned = 0;
  private dos = false;
  private zoned = false;

  /** Reads the time kinds of the rows from the last read row up to
   *  `rows`. It stops when it found both kinds. */
  scan(kindOf: (row: number) => number, rows: number): void {
    while (this.scanned < rows && !(this.dos && this.zoned)) {
      const kind = kindOf(this.scanned++);
      if (kind === TimeKind.DOS) this.dos = true;
      else if (kind !== TimeKind.NONE) this.zoned = true;
    }
  }

  /** True when the rows mix DOS times and times with a time zone: each
   *  DOS time gets the mark. */
  get mixed(): boolean {
    return this.dos && this.zoned;
  }

  /** True when the rows have DOS times and no time with a time zone: the
   *  column header notes it once. */
  get dosOnly(): boolean {
    return this.dos && !this.zoned;
  }
}
