/**
 * "What do I have here?" — answered as data, not prose.
 *
 * Every "interpret rather than restate" instruction the old list skill gave the
 * model is a rule that belongs here: `state → next command` is a switch, "a
 * collection with no matching config" is a set difference, "a leftover
 * container" is a container lookup, and low free space is a threshold. None of
 * it needs a model, and a model doing it costs a turn and can get it wrong.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ConfigSummary, readConfig } from "./config.ts";
import { runningCrawls } from "./engine.ts";
import { dirSize, fileSize, freeSpace } from "./sizes.ts";
import { CrawlTailer, type CrawlStats } from "./stats.ts";
import { runsFor, type Store } from "./store.ts";

/** A finished archive in the store's out/ directory. */
export interface Archive {
  collection: string;
  /** The .wacz, or the WARC directory when generateWACZ was off. */
  path: string;
  kind: "wacz" | "warc-dir";
  bytes?: number;
  /** From the .btrix.json sidecar, when present. */
  provenance?: {
    config?: string;
    crawler?: string;
    finishedAt?: string;
    pages?: { crawled?: number; total?: number; failed?: number };
    limitHit?: boolean;
    pageLimit?: number;
  };
}

export interface ActiveRun {
  config: string;
  collection: string;
  root: string;
  stats: CrawlStats;
}

export interface Inventory {
  store: Store;
  configs: ConfigSummary[];
  /** Runs with output, newest first per config. */
  runs: ActiveRun[];
  archives: Archive[];
  failed: { count: number; bytes?: number };
  profiles: { name: string; bytes?: number }[];
  free?: number;
  /** Crawler containers alive right now, by config name. */
  running: string[];
  /** Top-level ./collections, when a legacy or hand-run layout is present. */
  legacyCollections: string[];
  /** Configs that have never produced a run. */
  neverRun: string[];
  /** Archives or runs with no matching config — renamed or removed. */
  orphans: string[];
}

const readdir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

async function readArchives(store: Store): Promise<Archive[]> {
  const out: Archive[] = [];
  for (const entry of readdir(store.outDir).sort()) {
    const full = path.join(store.outDir, entry);
    if (entry.endsWith(".btrix.json")) continue;

    let provenance: Archive["provenance"];
    const sidecar = path.join(store.outDir, `${entry.replace(/\.wacz$/, "")}.btrix.json`);
    try {
      const d = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      provenance = {
        config: d.config,
        crawler: d.crawler,
        finishedAt: d.finishedAt,
        pages: d.pages,
        limitHit: d.limitHit,
        pageLimit: d.pageLimit,
      };
    } catch {
      // An archive without a sidecar is still an archive.
    }

    if (entry.endsWith(".wacz")) {
      out.push({
        collection: entry.replace(/\.wacz$/, ""),
        path: full,
        kind: "wacz",
        bytes: fileSize(full),
        provenance,
      });
    } else if (fs.statSync(full).isDirectory()) {
      out.push({
        collection: entry,
        path: full,
        kind: "warc-dir",
        bytes: await dirSize(full),
        provenance,
      });
    }
  }
  return out;
}

export async function buildInventory(store: Store, legacy?: string): Promise<Inventory> {
  const configs = readdir(store.configDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => readConfig(path.join(store.configDir, f), f.replace(/\.ya?ml$/, "")));

  const running = (await runningCrawls()).map((c) => c.config).filter((c): c is string => !!c);

  // Newest run per config that actually has output, so a config with twenty
  // attempts contributes one row.
  const runs: ActiveRun[] = [];
  for (const cfg of configs) {
    const root = runsFor(store, cfg.name).find((r) =>
      fs.existsSync(path.join(r, "collections", cfg.collection)),
    );
    if (!root) continue;
    const stats = await new CrawlTailer(cfg.collection, root, cfg.name).read();
    runs.push({ config: cfg.name, collection: cfg.collection, root, stats });
  }

  const failedDirs = readdir(store.failedDir);
  const archives = await readArchives(store);

  const profiles = readdir(store.profilesDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .sort()
    .map((f) => ({ name: f.replace(/\.tar\.gz$/, ""), bytes: fileSize(path.join(store.profilesDir, f)) }));

  const legacyCollections = legacy
    ? readdir(path.join(legacy, "collections")).filter((d) => {
        try {
          return fs.statSync(path.join(legacy, "collections", d)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];

  const configNames = new Set(configs.map((c) => c.name));
  const collectionNames = new Set(configs.map((c) => c.collection));

  return {
    store,
    configs,
    runs,
    archives,
    failed: { count: failedDirs.length, bytes: failedDirs.length ? await dirSize(store.failedDir) : undefined },
    profiles,
    free: await freeSpace(fs.existsSync(store.root) ? store.root : "."),
    running,
    legacyCollections,
    // "Never run" means no evidence it ever ran, so an archive counts even
    // when its run directory has since been pruned. Otherwise the inventory
    // contradicts itself, listing a config as never run and its archive in the
    // same breath.
    neverRun: configs
      .filter((c) => !runs.some((r) => r.config === c.name) && !archives.some((a) => a.collection === c.collection))
      .map((c) => c.name),
    orphans: [
      ...archives.map((a) => a.collection).filter((c) => !collectionNames.has(c)),
      ...running.filter((c) => !configNames.has(c)),
    ].filter((v, i, a) => a.indexOf(v) === i),
  };
}

/** The obvious next step for a crawl, as a rule rather than a paragraph. */
export function nextStep(state: CrawlStats["state"]): string {
  switch (state) {
    case "crawling":
    case "post-crawl":
    case "generating-wacz":
      return "in progress — the widget is showing it";
    case "done":
      return "replay it with btrix_view";
    case "stopped":
      return "ended early — btrix_status for why";
    case "no-stats":
      return "start it with btrix_run";
  }
}
