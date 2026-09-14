/**
 * Reclaiming space from finished and failed runs.
 *
 * Run directories are kept after a crawl so a review can read the page index
 * and a failure can be inspected, which means they accumulate. Nothing here
 * touches `out/`, `config/` or `profiles/`: archives, authored configs and
 * credentials are not disposable, and a cleanup that could delete them would be
 * a cleanup nobody should run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runningCrawls } from "./engine.ts";
import { dirSize } from "./sizes.ts";
import type { Store } from "./store.ts";

export type CleanTarget = "failed" | "runs" | "both";

export interface Candidate {
  path: string;
  kind: "failed" | "run";
  /** Config name parsed from the run id. */
  config?: string;
  ageDays: number;
  bytes?: number;
  /** Why it is being kept rather than offered for deletion. */
  keptBecause?: string;
}

export interface CleanPlan {
  candidates: Candidate[];
  kept: Candidate[];
  totalBytes: number;
}

const DAY = 24 * 60 * 60 * 1000;

async function scan(dir: string, kind: Candidate["kind"], now: number): Promise<Candidate[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    let mtime = now;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      // Unreadable; treat as new so it is not swept up silently.
    }
    out.push({
      path: full,
      kind,
      config: e.name.includes("-") ? e.name.slice(0, e.name.lastIndexOf("-")) : e.name,
      ageDays: Math.floor((now - mtime) / DAY),
      bytes: await dirSize(full),
    });
  }
  return out;
}

export async function planClean(
  store: Store,
  opts: { what?: CleanTarget; olderThanDays?: number; now?: number } = {},
): Promise<CleanPlan> {
  const now = opts.now ?? Date.now();
  const what = opts.what ?? "failed";
  const minAge = opts.olderThanDays ?? 0;

  const found: Candidate[] = [
    ...(what === "failed" || what === "both" ? await scan(store.failedDir, "failed", now) : []),
    ...(what === "runs" || what === "both" ? await scan(store.runsDir, "run", now) : []),
  ];

  const live = new Set((await runningCrawls()).map((c) => c.config).filter((c): c is string => !!c));

  const candidates: Candidate[] = [];
  const kept: Candidate[] = [];
  for (const c of found) {
    // Deleting the directory a container is writing into would break the crawl.
    if (c.config && live.has(c.config)) {
      kept.push({ ...c, keptBecause: `${c.config} is crawling right now` });
    } else if (c.ageDays < minAge) {
      kept.push({ ...c, keptBecause: `only ${c.ageDays} day(s) old` });
    } else {
      candidates.push(c);
    }
  }

  candidates.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  return { candidates, kept, totalBytes: candidates.reduce((n, c) => n + (c.bytes ?? 0), 0) };
}

/**
 * Delete the planned directories. Each path is re-checked against the store's
 * own runs/ and failed/ before removal, so a bug elsewhere cannot turn this
 * into a delete of something that matters.
 */
export async function applyClean(
  store: Store,
  plan: CleanPlan,
): Promise<{ removed: string[]; refused: string[]; bytes: number }> {
  const roots = [path.resolve(store.runsDir), path.resolve(store.failedDir)];
  const removed: string[] = [];
  const refused: string[] = [];
  // Counted as we go, not taken from the plan: reporting the plan's total
  // after refusing the single largest directory claims back bytes still on
  // the disk.
  let bytes = 0;

  for (const c of plan.candidates) {
    const target = path.resolve(c.path);
    const inside = roots.some((r) => target.startsWith(r + path.sep));
    if (!inside || target === path.resolve(store.root)) {
      refused.push(c.path);
      continue;
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      removed.push(c.path);
      bytes += c.bytes ?? 0;
    } catch {
      refused.push(c.path);
    }
  }
  return { removed, refused, bytes };
}
