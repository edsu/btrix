/**
 * Promoting a finished crawl. Every rename here is within one store, so these
 * are same-volume operations by construction.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishRun } from "../src/finish.ts";
import { buildInventory } from "../src/inventory.ts";
import type { CrawlStats } from "../src/stats.ts";
import { ensureStore, prepareRun, resolveStore, type Store } from "../src/store.ts";

let dir: string;
let store: Store;

const stats = (over: Partial<CrawlStats> = {}): CrawlStats => ({
  name: "stanford-news",
  config: "sulnews",
  state: "done",
  phase: "generating-wacz",
  containerRunning: false,
  containerKnown: true,
  crawled: 12,
  total: 12,
  failed: 0,
  excluded: 0,
  rateLimited: 0,
  limitHit: false,
  warnings: 0,
  errors: 0,
  pending: [],
  bytes: {},
  discovering: false,
  windowMs: 60_000,
  version: "1.14.3",
  ...over,
});

function makeRun(opts: { wacz?: boolean; warcs?: boolean } = {}): string {
  const run = prepareRun(store, "sulnews", new Date(2026, 8, 13, 11, 37, 5));
  const coll = path.join(run, "collections", "stanford-news");
  fs.mkdirSync(path.join(coll, "archive"), { recursive: true });
  if (opts.wacz) fs.writeFileSync(path.join(coll, "stanford-news.wacz"), Buffer.alloc(4096));
  if (opts.warcs) fs.writeFileSync(path.join(coll, "archive", "rec-1.warc.gz"), Buffer.alloc(2048));
  return run;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-finish-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
  fs.writeFileSync(path.join(store.configDir, "sulnews.yaml"), "collection: stanford-news\ngenerateWACZ: true\n");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("finishRun", () => {
  it("promotes the wacz into out/ with a provenance sidecar", async () => {
    const root = makeRun({ wacz: true, warcs: true });
    const out = await finishRun(store, { config: "sulnews", collection: "stanford-news", root }, stats());

    expect(out.kind).toBe("promoted");
    expect(out.dest).toBe(path.join(store.outDir, "stanford-news.wacz"));
    expect(fs.existsSync(out.dest!)).toBe(true);
    // No .partial left behind.
    expect(fs.readdirSync(store.outDir).filter((f) => f.endsWith(".partial"))).toEqual([]);

    const sidecar = JSON.parse(fs.readFileSync(out.sidecar!, "utf8"));
    expect(sidecar.collection).toBe("stanford-news");
    expect(sidecar.config).toBe("sulnews.yaml");
    expect(sidecar.crawler).toBe("1.14.3");
    // The config that produced it travels with the archive.
    expect(sidecar.configText).toContain("collection: stanford-news");
    expect(sidecar.pages).toEqual({ crawled: 12, total: 12, failed: 0 });
  });

  it("never overwrites an existing archive", async () => {
    const first = makeRun({ wacz: true });
    const a = await finishRun(store, { config: "sulnews", collection: "stanford-news", root: first }, stats());

    const second = makeRun({ wacz: true });
    const b = await finishRun(store, { config: "sulnews", collection: "stanford-news", root: second }, stats());

    expect(a.dest).not.toBe(b.dest);
    expect(fs.existsSync(a.dest!)).toBe(true);
    expect(fs.existsSync(b.dest!)).toBe(true);
    expect(path.basename(b.dest!)).toMatch(/^stanford-news-20260913T113705(-\d+)?\.wacz$/);
  });

  it("distinguishes generateWACZ being off from a crawl that ended early", async () => {
    // Same outcome on disk, quite different causes; guessing wrong misleads.
    const wanted = makeRun({ warcs: true });
    const a = await finishRun(store, { config: "sulnews", collection: "stanford-news", root: wanted }, stats());
    expect(a.kind).toBe("warc-only");
    expect(a.message).toContain("ended before a wacz was written");
    expect(a.message).toContain("re-crawling");
    expect(fs.existsSync(path.join(a.dest!, "archive", "rec-1.warc.gz"))).toBe(true);

    fs.writeFileSync(path.join(store.configDir, "nowacz.yaml"), "collection: nowacz\ngenerateWACZ: false\n");
    const off = prepareRun(store, "nowacz", new Date(2026, 8, 13, 12, 0, 0));
    const coll = path.join(off, "collections", "nowacz", "archive");
    fs.mkdirSync(coll, { recursive: true });
    fs.writeFileSync(path.join(coll, "rec-1.warc.gz"), Buffer.alloc(64));
    const b = await finishRun(store, { config: "nowacz", collection: "nowacz", root: off }, stats({ name: "nowacz" }));
    expect(b.kind).toBe("warc-only");
    expect(b.message).toContain("generateWACZ is off");
    expect(b.message).toContain("Set generateWACZ: true");

    // Beside the directory, not inside it: written inside, nothing ever reads
    // it, and the archive shows up with no provenance at all.
    expect(b.sidecar).toBe(path.join(store.outDir, "nowacz.btrix.json"));
    const inv = await buildInventory(store);
    const archive = inv.archives.find((a) => a.collection === "nowacz");
    expect(archive?.kind).toBe("warc-dir");
    expect(archive?.provenance?.config).toBe("nowacz.yaml");
    expect(archive?.provenance?.pages).toEqual({ crawled: 12, total: 12, failed: 0 });
  });

  it("parks a run that produced nothing, rather than discarding it", async () => {
    const root = makeRun();
    const out = await finishRun(store, { config: "sulnews", collection: "stanford-news", root }, stats({ state: "stopped" }));

    expect(out.kind).toBe("failed");
    expect(out.parked).toBe(path.join(store.failedDir, "sulnews-20260913T113705"));
    expect(fs.existsSync(out.parked!)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("leaves an adopted crawl where it is", async () => {
    // A hand-run `docker run -v $PWD:/crawls` crawl, or the M1 layout: its root
    // is outside the store, and moving it out from under someone would be wrong.
    const foreign = path.join(dir, "collections", "stanford-news");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "stanford-news.wacz"), Buffer.alloc(1024));

    const out = await finishRun(store, { config: "sulnews", collection: "stanford-news", root: dir }, stats());

    expect(out.kind).toBe("adopted");
    expect(out.message).toContain("btrix did not start this crawl");
    expect(fs.existsSync(path.join(foreign, "stanford-news.wacz"))).toBe(true);
    expect(fs.existsSync(store.outDir)).toBe(true);
    expect(fs.readdirSync(store.outDir)).toEqual([]);
  });
});

describe("path reporting", () => {
  it("does not emit a ../../.. chain for a store outside the cwd", async () => {
    const root = makeRun({ wacz: true });
    const out = await finishRun(store, { config: "sulnews", collection: "stanford-news", root }, stats());
    // The temp store is never under this process's cwd.
    expect(out.message).not.toContain("../..");
    expect(out.message).toContain(store.outDir);
  });
});
