/**
 * Promoting a finished crawl out of its run directory.
 *
 * Success means a WACZ exists, not that the container exited 0 — `deriveState`
 * separates `done` / `stopped` / `generating-wacz` for exactly this reason.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readConfig } from "./config.ts";
import { writeOutcomeMarker } from "./outcome.ts";
import { analyzePages, type PagesReport, readPages } from "./pages.ts";
import type { CrawlStats } from "./stats.ts";
import { collectionFor, type Store } from "./store.ts";

export interface Outcome {
  kind: "promoted" | "warc-only" | "failed" | "adopted";
  /** Where the deliverable ended up. */
  dest?: string;
  sidecar?: string;
  /** Where a failed run was parked, for inspection. */
  parked?: string;
  message: string;
}

/**
 * Relative when that is shorter and readable, absolute otherwise. A store moved
 * with `--dir` is not under the cwd, and a `../../../../var/folders/...` chain
 * helps nobody.
 */
function displayPath(target: string, from: string = process.cwd()): string {
  const rel = path.relative(from, target);
  return rel && !rel.startsWith("..") ? rel : target;
}

function findWacz(dir: string): string | undefined {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.endsWith(".wacz"));
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

function hasWarcs(archiveDir: string): boolean {
  try {
    return fs.readdirSync(archiveDir).some((f) => f.endsWith(".warc.gz") || f.endsWith(".warc"));
  } catch {
    return false;
  }
}

/**
 * Never overwrite an existing archive: a second crawl of the same site must not
 * silently replace the first one's output.
 */
function freeName(dir: string, base: string, ext: string, runName: string): string {
  const plain = path.join(dir, `${base}${ext}`);
  if (!fs.existsSync(plain)) return plain;
  const stamp = runName.slice(runName.lastIndexOf("-") + 1);
  let candidate = path.join(dir, `${base}-${stamp}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base}-${stamp}-${n++}${ext}`);
  return candidate;
}

function writeSidecar(
  target: string,
  store: Store,
  o: FinishOptions,
  stats: CrawlStats,
  review?: PagesReport,
): string {
  const configFile = path.join(o.root, "config", `${o.config}.yaml`);
  const sidecar = `${target.replace(/\.wacz$/, "")}.btrix.json`;
  let configText: string | undefined;
  try {
    configText = fs.readFileSync(configFile, "utf8");
  } catch {
    configText = undefined;
  }
  // Self-describing deliverable: the same facts the widget rendered, kept with
  // the archive so provenance survives someone emailing the WACZ onwards.
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        tool: "btrix",
        collection: o.collection,
        config: `${o.config}.yaml`,
        configText,
        crawler: stats.version,
        run: path.basename(o.root),
        finishedAt: new Date().toISOString(),
        pages: { crawled: stats.crawled, total: stats.total, failed: stats.failed },
        pageLimit: stats.pageLimit,
        limitHit: stats.limitHit,
        warnings: stats.warnings,
        errors: stats.errors,
        rateLimited: stats.rateLimited,
        lastProblem: stats.lastProblem,
        // Carried here so a review still works after the run directory is
        // pruned: the page index lives inside the wacz, which we would have to
        // unzip to read.
        review,
        stats,
      },
      null,
      2,
    ) + "\n",
  );
  return sidecar;
}

export interface FinishOptions {
  config: string;
  collection: string;
  /** The run directory, which is `WatchTarget.root`. */
  root: string;
}

/**
 * Move the deliverable into `out/`, or park the run under `failed/`.
 *
 * Every rename here is within one store, so it is always a same-volume
 * operation. The `.partial` step means an interrupted move cannot leave a
 * truncated file that looks like a valid archive.
 */
export async function finishRun(store: Store, o: FinishOptions, stats: CrawlStats): Promise<Outcome> {
  // Only runs btrix started are ours to move. A crawl adopted from a legacy or
  // hand-made working directory has its root outside the store, and moving
  // ./collections/<name> out from under someone else's crawl would be wrong.
  const inStore = path.resolve(o.root).startsWith(path.resolve(store.runsDir) + path.sep);
  if (!inStore) {
    const found = findWacz(path.join(o.root, "collections", o.collection));
    return {
      kind: "adopted",
      dest: found,
      message: found
        ? `${o.collection}: finished; wacz at ${displayPath(found)} (left in place — btrix did not start this crawl)`
        : `${o.collection}: finished, but produced no wacz (left in place — btrix did not start this crawl)`,
    };
  }

  const collectionDir = path.join(o.root, "collections", o.collection);
  const runName = path.basename(o.root);
  const wacz = findWacz(collectionDir);

  // Summarise the page index before anything moves.
  const pages = readPages(collectionDir);
  const review = pages.found ? analyzePages(pages) : undefined;

  if (wacz) {
    fs.mkdirSync(store.outDir, { recursive: true });
    const dest = freeName(store.outDir, o.collection, ".wacz", runName);
    const partial = `${dest}.partial`;
    await fs.promises.rename(wacz, partial);
    await fs.promises.rename(partial, dest);
    const sidecar = writeSidecar(dest, store, o, stats, review);
    // Record where it went, or anything later reading this run directory will
    // conclude the crawl never finished.
    writeOutcomeMarker(o.root, { kind: "promoted", dest, sidecar, at: new Date().toISOString() });
    return {
      kind: "promoted",
      dest,
      sidecar,
      message: `${o.collection}: wacz at ${displayPath(dest)}`,
    };
  }

  // No wacz, but WARCs exist. Two quite different situations, and guessing the
  // wrong one misleads: `generateWACZ: false` is a deliberate choice, while a
  // crawl that was stopped or died simply never reached packaging.
  if (hasWarcs(path.join(collectionDir, "archive"))) {
    fs.mkdirSync(store.outDir, { recursive: true });
    const dest = freeName(store.outDir, o.collection, "", runName);
    await fs.promises.rename(collectionDir, dest);
    const sidecar = writeSidecar(path.join(dest, o.collection), store, o, stats, review);
    writeOutcomeMarker(o.root, { kind: "warc-only", dest, sidecar, at: new Date().toISOString() });
    const wanted = readConfig(path.join(o.root, "config", `${o.config}.yaml`), o.config).generateWacz;
    return {
      kind: "warc-only",
      dest,
      sidecar,
      message: wanted
        ? `${o.collection}: ended before a wacz was written, so the warcs are what there is — ${displayPath(dest)}. ` +
          "They hold the pages that were captured, but ReplayWeb.page needs a wacz, so replaying means re-crawling."
        : `${o.collection}: generateWACZ is off for this config, so the warc directory is the deliverable — ` +
          `${displayPath(dest)}. Set generateWACZ: true if you want to replay it.`,
    };
  }

  writeOutcomeMarker(o.root, { kind: "failed", at: new Date().toISOString() });
  fs.mkdirSync(store.failedDir, { recursive: true });
  const parked = path.join(store.failedDir, runName);
  try {
    await fs.promises.rename(o.root, parked);
  } catch {
    // Leave it where it is rather than lose it.
    return { kind: "failed", parked: o.root, message: `${o.collection}: produced no archive; run kept at ${o.root}` };
  }
  return {
    kind: "failed",
    parked,
    message: `${o.collection}: produced no archive. The run is kept at ${displayPath(parked)} for inspection.`,
  };
}

export { collectionFor };
