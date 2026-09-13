/**
 * The record a run leaves of where its output went.
 *
 * Promotion moves a finished crawl's archive into the store's `out/`, which
 * means the run directory no longer contains the thing the crawler wrote. Left
 * unrecorded, anything reading that directory concludes the crawl never
 * finished — which is exactly what happened: a completed crawl kept reporting
 * "writing wacz" for the rest of the session.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const MARKER = ".btrix-outcome.json";

export interface OutcomeMarker {
  kind: "promoted" | "warc-only" | "failed";
  /** Where the deliverable ended up. */
  dest?: string;
  sidecar?: string;
  at: string;
}

export function writeOutcomeMarker(runRoot: string, marker: OutcomeMarker): void {
  try {
    fs.writeFileSync(path.join(runRoot, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  } catch {
    // Losing the marker costs accuracy in reporting, not data; never fail a
    // promotion over it.
  }
}

export function readOutcomeMarker(runRoot: string): OutcomeMarker | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(runRoot, MARKER), "utf8")) as OutcomeMarker;
    return d && typeof d.kind === "string" ? d : undefined;
  } catch {
    return undefined;
  }
}

/** The promoted `.wacz` for a run, if there is one and it still exists. */
export function promotedArchive(runRoot: string): string | undefined {
  const marker = readOutcomeMarker(runRoot);
  if (marker?.kind !== "promoted" || !marker.dest?.endsWith(".wacz")) return undefined;
  return fs.existsSync(marker.dest) ? marker.dest : undefined;
}
