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

  it("drops a crawl from the loop once it settles, so it stops being repainted", async () => {
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 2, total: 4 } }]);
    const ticks: CrawlStats[] = [];
    const onComplete = vi.fn();
    monitor = new CrawlMonitor({ onTick: (s) => ticks.push(s), onComplete });

    monitor.watch(target());
    // Pretend we saw it alive, which is what a real crawl does before ending.
    (monitor as any).entries.get("inkdroid").sawLive = true;

    await monitor.tick();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(monitor.watched()).toEqual([]);

    const after = ticks.length;
    await monitor.tick();
    // Nothing left to paint.
    expect(ticks.length).toBe(after);
  });

  it("reads without following, so a status check cannot resurrect a finished crawl", async () => {
    writeLog([{ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 4, total: 4 } }]);
    monitor = new CrawlMonitor();
    const stats = await monitor.stats(target());
    expect(stats.crawled).toBe(4);
    expect(monitor.watched()).toEqual([]);
  });
});
