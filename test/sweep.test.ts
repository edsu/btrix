/**
 * The startup sweep for crawls that finished while btrix was closed.
 *
 * The happy path is the least interesting part. `finishRun` parks a run with
 * no archive under `failed/`, so the cases that matter are the ones where the
 * sweep must decline: a crawl still running, a run already promoted, a
 * mid-crawl directory with warcs and no wacz, and an engine that cannot be
 * asked at all. Getting any of those wrong moves or parks something live.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishRun } from "../src/finish.ts";
import { writeOutcomeMarker } from "../src/outcome.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";
import { statsFor, type StrandedRun, strandedRuns, sweepStranded } from "../src/sweep.ts";

let dir: string;
let store: Store;

const config = (name: string, collection: string) =>
  fs.writeFileSync(
    path.join(store.configDir, `${name}.yaml`),
    `collection: ${collection}\ngenerateWACZ: true\n`,
  );

/** A run directory as the crawler leaves it. */
const run = (name: string, collection: string, stamp: string, files: string[]) => {
  const root = path.join(store.runsDir, `${name}-${stamp}`);
  const coll = path.join(root, "collections", collection);
  fs.mkdirSync(path.join(coll, "archive"), { recursive: true });
  for (const f of files) {
    const full = f.endsWith(".warc.gz") ? path.join(coll, "archive", f) : path.join(coll, f);
    fs.writeFileSync(full, Buffer.alloc(1024));
  }
  return root;
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "btrix-sweep-")));
  store = resolveStore({ dir: path.join(dir, "btrix"), cwd: dir });
  ensureStore(store);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const nothingRunning = () => false;

describe("strandedRuns", () => {
  it("finds a finished run that was never promoted", () => {
    config("sulnews", "stanford-news");
    const root = run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);
    expect(strandedRuns(store, nothingRunning).map((r) => r.root)).toEqual([root]);
  });

  it("skips a run whose config is crawling right now", () => {
    // The monitor is about to promote this properly; racing it would move the
    // wacz out from under the crawl that is still writing.
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);
    expect(strandedRuns(store, (c) => c === "sulnews")).toEqual([]);
  });

  it("skips a run that already has an outcome marker", () => {
    config("sulnews", "stanford-news");
    const root = run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);
    writeOutcomeMarker(root, { kind: "promoted", dest: "/somewhere.wacz", at: "2026-09-22T00:00:00Z" });
    expect(strandedRuns(store, nothingRunning)).toEqual([]);
  });

  it("skips a mid-crawl directory, which has warcs and no wacz", () => {
    // The dangerous case: finishRun would park this under failed/, and the
    // engine being wrong about what is running must not be enough to do that.
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["rec-1.warc.gz"]);
    expect(strandedRuns(store, nothingRunning)).toEqual([]);
  });

  it("takes every stranded run, not just the newest", () => {
    // The inventory shows one run per config, so an older stranded wacz is
    // invisible there and stays invisible unless this picks it up.
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260901T090000", ["stanford-news.wacz"]);
    run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);
    expect(strandedRuns(store, nothingRunning)).toHaveLength(2);
  });

  it("ignores a run with no matching config", () => {
    run("orphaned", "gone", "20260922T090000", ["gone.wacz"]);
    expect(strandedRuns(store, nothingRunning)).toEqual([]);
  });
});

describe("sweepStranded", () => {
  const deps = (ok: boolean, crawls: { config?: string }[] = []) => ({
    lookup: async () => ({ ok, crawls }),
    finish: async (r: StrandedRun) => finishRun(store, r, await statsFor(r)),
  });

  it("promotes into out/, so btrix_view can see it", async () => {
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);

    const result = await sweepStranded(store, deps(true));

    expect(result.promoted.map((o) => o.kind)).toEqual(["promoted"]);
    expect(fs.readdirSync(store.outDir)).toContain("stanford-news.wacz");
  });

  it("declines entirely when the engine cannot be asked", async () => {
    // Without an answer, a running crawl and a finished one look identical.
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);

    const result = await sweepStranded(store, deps(false));

    expect(result.skipped).toBe("engine-unavailable");
    expect(result.promoted).toEqual([]);
    expect(fs.readdirSync(store.outDir)).toEqual([]);
  });

  it("leaves a running crawl alone", async () => {
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);

    const result = await sweepStranded(store, deps(true, [{ config: "sulnews" }]));

    expect(result.promoted).toEqual([]);
    expect(fs.readdirSync(store.outDir)).toEqual([]);
  });

  it("is idempotent: a second sweep promotes nothing", async () => {
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["stanford-news.wacz"]);

    await sweepStranded(store, deps(true));
    const again = await sweepStranded(store, deps(true));

    expect(again.promoted).toEqual([]);
    expect(fs.readdirSync(store.outDir).filter((f) => f.endsWith(".wacz"))).toHaveLength(1);
  });

  it("keeps going when one run cannot be moved", async () => {
    config("a", "coll-a");
    config("b", "coll-b");
    run("a", "coll-a", "20260922T090000", ["coll-a.wacz"]);
    run("b", "coll-b", "20260922T090000", ["coll-b.wacz"]);

    const result = await sweepStranded(store, {
      lookup: async () => ({ ok: true, crawls: [] }),
      finish: async (r) => {
        if (r.config === "a") throw new Error("disk full");
        return finishRun(store, r, await statsFor(r));
      },
    });

    expect(result.promoted.map((o) => o.kind)).toEqual(["promoted"]);
    expect(fs.readdirSync(store.outDir)).toContain("coll-b.wacz");
  });

  it("does not park a mid-crawl run under failed/", async () => {
    config("sulnews", "stanford-news");
    run("sulnews", "stanford-news", "20260922T090000", ["rec-1.warc.gz"]);

    await sweepStranded(store, deps(true));

    expect(fs.readdirSync(store.failedDir)).toEqual([]);
    expect(fs.readdirSync(store.runsDir)).toHaveLength(1);
  });
});
