/**
 * Archives that finished while nobody was watching.
 *
 * Promotion into `out/` is driven by the monitor seeing a crawl end
 * (`index.ts` -> `finishRun`), and crawls are detached on purpose. So a crawl
 * that finishes after btrix is closed is never promoted: its wacz stays under
 * `runs/`, `readArchives` scans only `out/`, and `btrix_view` reports "no
 * archives in the store yet" about a crawl the inventory is simultaneously
 * describing as ready to replay. `clean.ts` already refuses to reclaim these,
 * so they accumulate rather than being lost -- invisible, but intact.
 *
 * This is the other half of that: find them on startup and promote them
 * through the same `finishRun` a live observation would have used, so there is
 * one promotion path and one set of semantics rather than two.
 *
 * The safety rule here is narrow on purpose. `finishRun` parks a run with no
 * archive under `failed/`, which is right when the monitor watched the crawl
 * die and wrong when all we know is that a directory exists. So a run is only
 * swept when a wacz is actually on disk. A mid-crawl directory has warcs and
 * no wacz, and is therefore never touched, even if the engine lies about what
 * is running.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readConfig } from "./config.ts";
import type { Outcome } from "./finish.ts";
import { readOutcomeMarker } from "./outcome.ts";
import { CrawlTailer } from "./stats.ts";
import { runsFor, type Store } from "./store.ts";

export interface StrandedRun {
  config: string;
  collection: string;
  /** The run directory, which `finishRun` takes as `root`. */
  root: string;
  /** The wacz that should have been promoted. */
  wacz: string;
}

function findWacz(dir: string): string | undefined {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.endsWith(".wacz"));
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs holding a wacz that promotion never reached.
 *
 * `isRunning` is passed in rather than asked for here, so this is decidable
 * from the filesystem alone and testable without an engine.
 *
 * Every run of a config is considered, not just the newest. The inventory only
 * ever shows the newest, so an older stranded one is invisible there and stays
 * invisible for good; and `freeName` in `finishRun` already keeps two archives
 * of one collection from colliding.
 */
export function strandedRuns(store: Store, isRunning: (config: string) => boolean): StrandedRun[] {
  let configFiles: string[];
  try {
    configFiles = fs.readdirSync(store.configDir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return [];
  }

  const found: StrandedRun[] = [];
  for (const file of configFiles.sort()) {
    const name = file.replace(/\.ya?ml$/, "");
    // A running crawl is the monitor's to finish. Moving its wacz out from
    // under it would race the thing that is about to do it properly.
    if (isRunning(name)) continue;
    const { collection } = readConfig(path.join(store.configDir, file), name);

    for (const root of runsFor(store, name)) {
      // A marker means promotion already ran here -- promoted, warc-only or
      // failed. Re-running would move an archive a second time.
      if (readOutcomeMarker(root)) continue;
      const wacz = findWacz(path.join(root, "collections", collection));
      if (!wacz) continue;
      found.push({ config: name, collection, root, wacz });
    }
  }
  return found;
}

export interface SweepDeps {
  /** `crawlLookup`, so "the engine could not be asked" stays distinguishable. */
  lookup(): Promise<{ ok: boolean; crawls: { config?: string }[] }>;
  finish(run: StrandedRun): Promise<Outcome>;
}

export interface SweepResult {
  promoted: Outcome[];
  /** Set when the sweep declined to run at all, for the caller to report. */
  skipped?: "engine-unavailable";
}

/**
 * Promote what the monitor never got to see.
 *
 * Declines entirely when the engine cannot be asked: without that answer a
 * running crawl is indistinguishable from a finished one, and the conservative
 * reading is that everything is still running.
 */
export async function sweepStranded(store: Store, deps: SweepDeps): Promise<SweepResult> {
  const { ok, crawls } = await deps.lookup();
  if (!ok) return { promoted: [], skipped: "engine-unavailable" };

  const live = new Set(crawls.map((c) => c.config).filter((c): c is string => !!c));
  const promoted: Outcome[] = [];
  for (const run of strandedRuns(store, (config) => live.has(config))) {
    try {
      promoted.push(await deps.finish(run));
    } catch {
      // One unmovable run must not stop the rest, and must not stop startup.
      // It stays where it is, which is where it already was.
    }
  }
  return { promoted };
}

/** The stats `finishRun` records in the sidecar, read back off the run. */
export function statsFor(run: StrandedRun) {
  return new CrawlTailer(run.collection, run.root, run.config).read();
}
