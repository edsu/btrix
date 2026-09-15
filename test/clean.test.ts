/**
 * Reclaiming space. The guards matter: this is the only thing in btrix that
 * deletes, and the things it must never delete are the whole point of the tool.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyClean, planClean } from "../src/clean.ts";
import { CrawlMonitor } from "../src/monitor.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";
import { createTools } from "../src/tools.ts";

let dir: string;
let store: Store;
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function make(parent: string, name: string, ageDays: number, bytes = 1024) {
  const full = path.join(parent, name);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, "blob"), Buffer.alloc(bytes));
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(full, t, t);
  return full;
}

let tools: ReturnType<typeof createTools>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-clean-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
  tools = createTools(new CrawlMonitor(), () => store);
});

/** A context whose confirm dialog answers the way the test wants. */
const withUI = (answer: boolean) => {
  const asked: string[] = [];
  return {
    asked,
    ctx: {
      hasUI: true,
      ui: {
        confirm: async (title: string, message: string) => {
          asked.push(`${title}\n${message}`);
          return answer;
        },
      },
    } as never,
  };
};

const clean = (params: unknown, ctx: unknown = {}) =>
  tools.find((t) => t.name === "btrix_clean")!.execute("id", params as never, undefined, undefined, ctx as never);
const said = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join(" ");
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("planClean", () => {
  it("defaults to failed runs only, leaving completed runs alone", async () => {
    make(store.failedDir, "toi-20260901T090000", 12);
    make(store.runsDir, "sulnews-20260910T090000", 3);

    const plan = await planClean(store, { now: NOW });
    expect(plan.candidates.map((c) => path.basename(c.path))).toEqual(["toi-20260901T090000"]);
  });

  it("can include completed runs when asked", async () => {
    make(store.failedDir, "toi-20260901T090000", 12);
    make(store.runsDir, "sulnews-20260910T090000", 3);

    const plan = await planClean(store, { what: "both", now: NOW });
    expect(plan.candidates).toHaveLength(2);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });

  it("respects an age floor and explains what it kept", async () => {
    make(store.failedDir, "old-20260801T090000", 40);
    make(store.failedDir, "new-20260912T090000", 1);

    const plan = await planClean(store, { olderThanDays: 7, now: NOW });
    expect(plan.candidates.map((c) => path.basename(c.path))).toEqual(["old-20260801T090000"]);
    expect(plan.kept[0]!.keptBecause).toContain("day(s) old");
  });

  it("orders the biggest first, since that is why anyone runs this", async () => {
    make(store.failedDir, "small-20260901T090000", 12, 1024);
    make(store.failedDir, "big-20260901T090000", 12, 200 * 1024);
    const plan = await planClean(store, { now: NOW });
    expect(path.basename(plan.candidates[0]!.path)).toBe("big-20260901T090000");
  });
});

describe("planClean and un-promoted archives", () => {
  // finishRun only moves a WACZ into out/ when the monitor watches the crawl
  // finish. Crawls are detached, so quitting first leaves it here, invisible
  // to btrix_list and with its config no longer running.
  const withWacz = (parent: string, name: string, ageDays: number, file = "web-archiving.wacz") => {
    const full = make(parent, name, ageDays);
    const coll = path.join(full, "collections", "web-archiving");
    fs.mkdirSync(coll, { recursive: true });
    fs.writeFileSync(path.join(coll, file), Buffer.alloc(2048));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(full, t, t);
    return full;
  };

  it("keeps a run directory holding the only copy of a wacz", async () => {
    const orphan = withWacz(store.runsDir, "wikipedia-20260901T090000", 30);
    const plan = await planClean(store, { what: "runs", now: NOW });

    expect(plan.candidates).toEqual([]);
    expect(plan.kept.map((k) => k.keptBecause)).toEqual([
      expect.stringContaining("still holds an archive"),
    ]);
    // And it is still there after a full apply.
    await applyClean(store, plan);
    expect(fs.existsSync(path.join(orphan, "collections", "web-archiving", "web-archiving.wacz"))).toBe(true);
  });

  it("keeps one holding raw warcs, which are also an archive", async () => {
    withWacz(store.runsDir, "toi-20260901T090000", 30, "rec-1.warc.gz");
    const plan = await planClean(store, { what: "runs", now: NOW });
    expect(plan.candidates).toEqual([]);
  });

  it("still reclaims a run directory with no archive in it", async () => {
    make(store.runsDir, "spent-20260901T090000", 30);
    const plan = await planClean(store, { what: "runs", now: NOW });
    expect(plan.candidates.map((c) => path.basename(c.path))).toEqual(["spent-20260901T090000"]);
  });

  it("keeps the archive-holding one and reclaims the rest in the same sweep", async () => {
    withWacz(store.runsDir, "keep-20260901T090000", 30);
    make(store.runsDir, "drop-20260901T090000", 30);
    const plan = await planClean(store, { what: "runs", now: NOW });

    expect(plan.candidates.map((c) => path.basename(c.path))).toEqual(["drop-20260901T090000"]);
    expect(plan.kept.map((c) => path.basename(c.path))).toEqual(["keep-20260901T090000"]);
  });

  it("looks inside a failed run too, which can hold a partial capture", async () => {
    withWacz(store.failedDir, "died-20260901T090000", 30, "rec-1.warc.gz");
    const plan = await planClean(store, { what: "both", now: NOW });
    expect(plan.candidates).toEqual([]);
  });
});

describe("applyClean", () => {
  it("removes only what was planned", async () => {
    const doomed = make(store.failedDir, "toi-20260901T090000", 12);
    const plan = await planClean(store, { now: NOW });
    const { removed, refused } = await applyClean(store, plan);

    expect(removed).toEqual([doomed]);
    expect(refused).toEqual([]);
    expect(fs.existsSync(doomed)).toBe(false);
    // The store itself survives.
    expect(fs.existsSync(store.failedDir)).toBe(true);
  });

  it("refuses anything outside runs/ and failed/, whatever the plan says", async () => {
    // Archives, configs and credentials are not disposable, so a bug that put
    // them in a plan must not be able to delete them.
    fs.writeFileSync(path.join(store.outDir, "precious.wacz"), Buffer.alloc(16));
    fs.writeFileSync(path.join(store.profilesDir, "example.org.tar.gz"), Buffer.alloc(16));

    const { removed, refused } = await applyClean(store, {
      totalBytes: 0,
      kept: [],
      candidates: [
        { path: store.outDir, kind: "run", ageDays: 99 },
        { path: store.profilesDir, kind: "run", ageDays: 99 },
        { path: store.configDir, kind: "run", ageDays: 99 },
        { path: store.root, kind: "run", ageDays: 99 },
        { path: path.join(dir, "unrelated"), kind: "run", ageDays: 99 },
      ],
    });

    expect(removed).toEqual([]);
    expect(refused).toHaveLength(5);
    expect(fs.existsSync(path.join(store.outDir, "precious.wacz"))).toBe(true);
    expect(fs.existsSync(path.join(store.profilesDir, "example.org.tar.gz"))).toBe(true);
    expect(fs.existsSync(store.configDir)).toBe(true);
  });
});

describe("btrix_clean asks before deleting", () => {
  it("deletes what the user confirmed", async () => {
    const doomed = make(store.failedDir, "toi-20260901T090000", 30);
    const { ctx, asked } = withUI(true);

    const out = said(await clean({ remove: true }, ctx));

    expect(asked).toHaveLength(1);
    // The dialog names the directory it is about to remove, not just a count.
    expect(asked[0]).toContain("toi-20260901T090000");
    expect(asked[0]).toContain("cannot be undone");
    expect(out).toContain("Removed 1");
    expect(fs.existsSync(doomed)).toBe(false);
  });

  it("deletes nothing when the user declines", async () => {
    const spared = make(store.failedDir, "toi-20260901T090000", 30);
    const { ctx } = withUI(false);

    const out = said(await clean({ remove: true }, ctx));

    expect(out).toContain("nothing was deleted");
    expect(fs.existsSync(spared)).toBe(true);
  });

  it("does not ask when only reporting", async () => {
    const kept = make(store.failedDir, "toi-20260901T090000", 30);
    const { ctx, asked } = withUI(true);

    const out = said(await clean({}, ctx));

    expect(asked).toEqual([]);
    expect(out).toContain("could be removed");
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("never offers an archive-holding directory, so it cannot be confirmed away", async () => {
    const coll = path.join(store.runsDir, "wikipedia-20260901T090000", "collections", "web-archiving");
    fs.mkdirSync(coll, { recursive: true });
    fs.writeFileSync(path.join(coll, "web-archiving.wacz"), Buffer.alloc(2048));
    const { ctx, asked } = withUI(true);

    const out = said(await clean({ what: "runs", remove: true }, ctx));

    expect(asked).toEqual([]);
    expect(out).toContain("Nothing to reclaim");
    expect(fs.existsSync(path.join(coll, "web-archiving.wacz"))).toBe(true);
  });
});
