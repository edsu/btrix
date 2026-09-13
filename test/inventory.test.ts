/**
 * The inventory, and the rules that used to be prose in the list skill.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { buildInventory, nextStep } from "../src/inventory.ts";
import { inventoryForModel, plainTheme, renderInventory } from "../src/render.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";

let dir: string;
let store: Store;

const config = (name: string, body: string) => fs.writeFileSync(path.join(store.configDir, `${name}.yaml`), body);

function fakeRun(cfg: string, collection: string, stamp: string, lines: object[]) {
  const run = path.join(store.runsDir, `${cfg}-${stamp}`);
  const logs = path.join(run, "collections", collection, "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "a.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return run;
}

const statLine = (crawled: number, total: number, extra: object = {}) => ({
  context: "crawlStatus",
  message: "Crawl statistics",
  details: { crawled, total, failed: 0, ...extra },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-inv-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("pulls out the keys the inventory shows", () => {
    const f = path.join(dir, "sulnews.yaml");
    fs.writeFileSync(
      f,
      [
        "collection: stanford-news",
        "generateWACZ: true",
        "scopeType: prefix",
        "pageLimit: 25",
        "text: to-pages,to-warc",
        "customBehaviors:",
        "  - /crawls/config/behaviors/load-more.js",
        "seeds:",
        "  - url: https://library.stanford.edu/news",
      ].join("\n"),
    );
    const c = readConfig(f, "sulnews");
    expect(c).toMatchObject({
      collection: "stanford-news",
      seed: "https://library.stanford.edu/news",
      scopeType: "prefix",
      pageLimit: 25,
      behaviors: ["load-more.js"],
      generateWacz: true,
      textToPages: true,
    });
  });

  it("treats a missing generateWACZ as no wacz, since that is what happens", () => {
    const f = path.join(dir, "plain.yaml");
    fs.writeFileSync(f, "seeds:\n  - url: https://example.com/\n");
    const c = readConfig(f, "plain");
    expect(c.generateWacz).toBe(false);
    expect(c.textToPages).toBe(false);
    expect(c.collection).toBe("plain");
  });
});

describe("nextStep", () => {
  it("maps state to the obvious next action, as a rule not a paragraph", () => {
    expect(nextStep("no-stats")).toContain("btrix_run");
    expect(nextStep("done")).toContain("btrix_view");
    expect(nextStep("stopped")).toContain("btrix_status");
    expect(nextStep("crawling")).toContain("in progress");
  });
});

describe("buildInventory", () => {
  it("reports configs that have never run", async () => {
    config("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    config("other", "generateWACZ: true\n");
    const inv = await buildInventory(store);
    expect(inv.neverRun.sort()).toEqual(["other", "sulnews"]);
    expect(inv.runs).toEqual([]);
  });

  it("does not call a config never-run when its archive is right there", async () => {
    // Run directories get pruned; archives do not. The inventory must not then
    // claim the crawl never happened.
    config("cultprotest", "collection: cultprotest\ngenerateWACZ: true\n");
    fs.writeFileSync(path.join(store.outDir, "cultprotest.wacz"), Buffer.alloc(64));

    const inv = await buildInventory(store);
    expect(inv.neverRun).toEqual([]);
    expect(inv.archives).toHaveLength(1);
    const forModel = inventoryForModel(inv);
    expect(forModel).not.toContain("never run");
    expect(forModel).toContain("archive cultprotest");
  });

  it("uses the newest run per config and reads its state", async () => {
    config("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    fakeRun("sulnews", "stanford-news", "20260913T100000", [statLine(1, 9)]);
    fakeRun("sulnews", "stanford-news", "20260913T120000", [statLine(7, 9)]);

    const inv = await buildInventory(store);
    expect(inv.runs).toHaveLength(1);
    expect(inv.runs[0]!.root).toContain("20260913T120000");
    expect(inv.runs[0]!.stats.crawled).toBe(7);
    expect(inv.neverRun).toEqual([]);
  });

  it("lists archives with their provenance, and flags a truncated crawl", async () => {
    config("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    fs.writeFileSync(path.join(store.outDir, "stanford-news.wacz"), Buffer.alloc(2048));
    fs.writeFileSync(
      path.join(store.outDir, "stanford-news.btrix.json"),
      JSON.stringify({ config: "sulnews.yaml", crawler: "1.14.3", pages: { crawled: 3, total: 3 }, limitHit: true, pageLimit: 3 }),
    );

    const inv = await buildInventory(store);
    expect(inv.archives).toHaveLength(1);
    expect(inv.archives[0]).toMatchObject({ collection: "stanford-news", kind: "wacz", bytes: 2048 });
    expect(inv.archives[0]!.provenance).toMatchObject({ crawler: "1.14.3", limitHit: true, pageLimit: 3 });

    // A truncated crawl must not read as a complete one.
    expect(inventoryForModel(inv)).toContain("truncated at pageLimit");
    expect(renderInventory(inv, plainTheme).join("\n")).toContain("truncated at pageLimit 3");
  });

  it("notices an archive with no matching config", async () => {
    fs.writeFileSync(path.join(store.outDir, "renamed.wacz"), Buffer.alloc(10));
    const inv = await buildInventory(store);
    // A set difference, not a guess about what the user did.
    expect(inv.orphans).toContain("renamed");
    expect(inventoryForModel(inv)).toContain("no matching config");
  });

  it("counts parked failed runs and their size", async () => {
    fs.mkdirSync(path.join(store.failedDir, "sulnews-20260913T090000"), { recursive: true });
    fs.writeFileSync(path.join(store.failedDir, "sulnews-20260913T090000", "runner.log"), "boom\n");
    const inv = await buildInventory(store);
    expect(inv.failed.count).toBe(1);
    expect(inventoryForModel(inv)).toContain("1 failed run(s)");
  });

  it("reports crawls sitting outside the store", async () => {
    fs.mkdirSync(path.join(dir, "collections", "oldcrawl"), { recursive: true });
    const inv = await buildInventory(store, dir);
    expect(inv.legacyCollections).toEqual(["oldcrawl"]);
    expect(inventoryForModel(inv)).toContain("outside the store");
  });

  it("shows a config that cannot produce a wacz before the crawl, not after", async () => {
    config("nowacz", "seeds:\n  - url: https://example.com/\n");
    const inv = await buildInventory(store);
    expect(renderInventory(inv, plainTheme).join("\n")).toContain("no wacz");
  });
});
