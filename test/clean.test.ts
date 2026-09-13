/**
 * Reclaiming space. The guards matter: this is the only thing in btrix that
 * deletes, and the things it must never delete are the whole point of the tool.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyClean, planClean } from "../src/clean.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-clean-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
});
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
