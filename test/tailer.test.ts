/**
 * Exercises the filesystem side of the tailer: byte offsets, appended lines,
 * torn tails, WACZ detection and the derived rates. No container required.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrawlTailer, discoverCollections } from "../src/stats.ts";

let dir: string;
const NAME = "sample";

const statusLine = (crawled: number, total: number, ts: string) =>
  JSON.stringify({
    timestamp: ts,
    logLevel: "info",
    context: "crawlStatus",
    message: "Crawl statistics",
    details: { crawled, total, failed: 0, excluded: 0, pending: total - crawled, pendingPages: [] },
  }) + "\n";

const logFile = () => path.join(dir, "collections", NAME, "logs", "20260913000000000.log");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-test-"));
  fs.mkdirSync(path.join(dir, "collections", NAME, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "collections", NAME, "archive"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CrawlTailer", () => {
  it("takes the screencast port from the run's own copy of the config", async () => {
    fs.writeFileSync(logFile(), statusLine(2, 10, "2026-09-13T00:00:00.000Z"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "mycfg.yaml"), "collection: sample\nscreencastPort: 9999\n");

    // The run directory's copy, not the store's live config: that copy is what
    // the running crawler was actually given.
    expect((await new CrawlTailer(NAME, dir, "mycfg").read(1_000_000)).screencastPort).toBe(9999);
  });

  it("offers no screencast port when the run did not enable one", async () => {
    fs.writeFileSync(logFile(), statusLine(2, 10, "2026-09-13T00:00:00.000Z"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "mycfg.yaml"), "collection: sample\n");
    expect((await new CrawlTailer(NAME, dir, "mycfg").read(1_000_000)).screencastPort).toBeUndefined();

    // A legacy or hand-run directory has no config name at all, so there is
    // nothing to look up and nothing to offer.
    expect((await new CrawlTailer(NAME, dir).read(1_000_000)).screencastPort).toBeUndefined();
  });

  it("accumulates across reads and only consumes appended bytes", async () => {
    fs.writeFileSync(logFile(), statusLine(2, 10, "2026-09-13T00:00:00.000Z"));
    const tailer = new CrawlTailer(NAME, dir);

    const first = await tailer.read(1_000_000);
    expect(first.crawled).toBe(2);
    expect(first.total).toBe(10);
    expect(first.state).toBe("stopped"); // no container, no wacz
    expect(first.pagesPerMin).toBeUndefined(); // one sample is not a rate

    fs.appendFileSync(logFile(), statusLine(8, 12, "2026-09-13T00:01:00.000Z"));
    const second = await tailer.read(1_060_000);
    expect(second.crawled).toBe(8);
    expect(second.total).toBe(12);
    // 6 pages over a 60s window.
    expect(second.pagesPerMin).toBeCloseTo(6, 1);
    expect(second.discovering).toBe(true);
    expect(second.windowMs).toBe(60_000);
  });

  it("holds a torn final line until the crawler finishes writing it", async () => {
    fs.writeFileSync(logFile(), statusLine(1, 5, "2026-09-13T00:00:00.000Z"));
    const partial = statusLine(4, 5, "2026-09-13T00:00:30.000Z");
    const cut = partial.slice(0, 40);
    fs.appendFileSync(logFile(), cut);

    const tailer = new CrawlTailer(NAME, dir);
    expect((await tailer.read(1_000_000)).crawled).toBe(1);

    fs.appendFileSync(logFile(), partial.slice(40));
    expect((await tailer.read(1_030_000)).crawled).toBe(4);
  });

  it("goes to done when a WACZ appears, and reports its size", async () => {
    fs.writeFileSync(logFile(), statusLine(5, 5, "2026-09-13T00:00:00.000Z"));
    const tailer = new CrawlTailer(NAME, dir);
    await tailer.read(1_000_000);

    fs.writeFileSync(path.join(dir, "collections", NAME, `${NAME}.wacz`), Buffer.alloc(2048));
    // Sizes are cached for a few seconds; advance past the refresh interval.
    const done = await tailer.read(1_010_000);
    expect(done.state).toBe("done");
    expect(done.waczPath).toContain(`${NAME}.wacz`);
    expect(done.bytes.wacz).toBe(2048);
  });

  it("survives a collection with no logs at all", async () => {
    fs.rmSync(path.join(dir, "collections", NAME, "logs"), { recursive: true });
    const stats = await new CrawlTailer(NAME, dir).read(1_000_000);
    expect(stats.state).toBe("no-stats");
    expect(stats.crawled).toBe(0);
  });

  it("lists collection directories", () => {
    expect(discoverCollections(dir)).toEqual([NAME]);
    expect(discoverCollections(path.join(dir, "nope"))).toEqual([]);
  });
});
