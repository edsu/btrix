/**
 * The poll loop. The interesting property is that a crawl leaves it once it is
 * done — a settled entry left in the loop keeps being repainted, which is how a
 * finished crawl ended up sitting in the widget looking active.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrawlMonitor, type WatchTarget } from "../src/monitor.ts";
import type { CrawlStats } from "../src/stats.ts";

let dir: string;
let monitor: CrawlMonitor;

const target = (): WatchTarget => ({ config: "inkdroid", collection: "inkdroid", root: dir });

function writeLog(lines: object[]) {
  const logs = path.join(dir, "collections", "inkdroid", "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "a.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-monitor-"));
});
afterEach(() => {
  monitor?.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CrawlMonitor", () => {
  it("does not announce a crawl that was already finished when we started", async () => {
    // Adopting a store full of old crawls must not fire completions for them.
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 4, total: 4 } }]);
    const onComplete = vi.fn();
    monitor = new CrawlMonitor({ onComplete });

    monitor.watch(target());
    await monitor.tick();
    await monitor.tick();

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("adopts from a crawl list handed in, without asking the engine again", async () => {
    // Startup needs the same `docker ps` answer twice -- once to adopt live
    // crawls, once to decide which finished runs the sweep may promote -- and
    // on a cold daemon each call is seconds. Passing the list in is what makes
    // that one call. Nothing is actually running here, so an adoption can only
    // have come from the list.
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 1, total: 4 } }]);
    monitor = new CrawlMonitor({});

    const adopted = await monitor.adoptRunning(
      (config) => (config === "inkdroid" ? target() : undefined),
      [{ id: "abc123", config: "inkdroid" }],
    );

    expect(adopted.map((t) => t.config)).toEqual(["inkdroid"]);
    expect(monitor.watched().map((t) => t.config)).toEqual(["inkdroid"]);
  });

  it("still asks the engine when no list is handed in", async () => {
    // The /btrix command has no lookup of its own to share, so the old path
    // has to keep working. Nothing is running, so this adopts nothing.
    monitor = new CrawlMonitor({});
    expect(await monitor.adoptRunning(() => target())).toEqual([]);
  });

  it("drops a crawl from the loop once it settles, so it stops being repainted", async () => {
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 2, total: 4 } }]);
    const ticks: CrawlStats[] = [];
    const onComplete = vi.fn();
    monitor = new CrawlMonitor({ onTick: (s) => ticks.push(s), onComplete });

    monitor.watch(target());
    // Pretend we saw it alive, which is what a real crawl does before ending.
    (monitor as any).entries.get("inkdroid").sawLive = true;

    // Settling is irreversible — it renames the collection directory — so it
    // takes several agreeing observations, not one.
    await monitor.tick();
    expect(onComplete).not.toHaveBeenCalled();
    await monitor.tick();
    await monitor.tick();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(monitor.watched()).toEqual([]);

    const after = ticks.length;
    await monitor.tick();
    // Nothing left to paint.
    expect(ticks.length).toBe(after);
  });

  it("does not settle on a tick where the engine could not be asked", async () => {
    // `runningCrawls` reports an empty list both when nothing is running and
    // when `docker ps` timed out. Settling on the latter renames the
    // collection directory out from under a crawler still writing to it.
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 2, total: 4 } }]);
    const onComplete = vi.fn();
    monitor = new CrawlMonitor({ onComplete });

    monitor.watch(target());
    const entry = (monitor as any).entries.get("inkdroid");
    entry.sawLive = true;
    const real = await monitor.stats(target());
    entry.tailer = {
      read: async (): Promise<CrawlStats> => ({
        ...real,
        state: "stopped",
        containerRunning: false,
        containerKnown: false,
      }),
    };

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    expect(onComplete).not.toHaveBeenCalled();
    expect(monitor.watched()).toHaveLength(1);
  });

  it("hands back the last tick's reading without provoking another", async () => {
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 4, total: 9 } }]);
    monitor = new CrawlMonitor({ intervalMs: 10_000 });

    // Nothing observed yet, so there is nothing to hand back.
    monitor.watch(target());
    expect(monitor.lastStats(target())).toBeUndefined();

    await monitor.tick();
    expect(monitor.lastStats(target())?.crawled).toBe(4);

    // A second call must not re-read the log: `foldLine` accumulates, so a
    // duplicate pass would double cumulative counters. Same object, untouched.
    const first = monitor.lastStats(target());
    expect(monitor.lastStats(target())).toBe(first);

    // Unknown target, and a target whose run directory has moved, get nothing
    // rather than another crawl's numbers.
    expect(monitor.lastStats({ config: "other", collection: "other", root: dir })).toBeUndefined();
    expect(monitor.lastStats({ ...target(), root: "/elsewhere" })).toBeUndefined();
  });

  it("reads without following, so a status check cannot resurrect a finished crawl", async () => {
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 4, total: 4 } }]);
    monitor = new CrawlMonitor();
    const stats = await monitor.stats(target());
    expect(stats.crawled).toBe(4);
    expect(monitor.watched()).toEqual([]);
  });
});
