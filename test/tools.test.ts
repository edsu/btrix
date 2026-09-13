/**
 * Tool guard paths that need neither a container nor a model.
 *
 * The paths that do start a container are left to manual end-to-end runs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrawlMonitor } from "../src/monitor.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";
import { configPath, createTools, listConfigs, normalizeName, resolveTarget } from "../src/tools.ts";

let dir: string;
let store: Store;
let tools: ReturnType<typeof createTools>;
let monitor: CrawlMonitor;

const tool = (name: string) => tools.find((t) => t.name === name)!;
const run = (t: any, params: any) => t.execute("id", params, undefined, undefined, {} as any);
const said = (r: any) => r.content.map((c: any) => c.text).join(" ");

const writeConfig = (name: string, body = "seeds: []\n") =>
  fs.writeFileSync(path.join(store.configDir, `${name}.yaml`), body);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-tools-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
  monitor = new CrawlMonitor();
  tools = createTools(monitor, () => store);
});

afterEach(() => {
  monitor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("btrix_run guards", () => {
  it("says there are no configs rather than starting anything", async () => {
    const out = said(await run(tool("btrix_run"), { config: "nope" }));
    expect(out).toContain("No nope.yaml");
    expect(out).toContain("no configs yet");
  });

  it("lists the configs that do exist when the name is wrong", async () => {
    writeConfig("sulnews");
    fs.writeFileSync(path.join(store.configDir, "cultprotest.yml"), "seeds: []\n");
    const out = said(await run(tool("btrix_run"), { config: "typo" }));
    expect(out).toContain("cultprotest");
    expect(out).toContain("sulnews");
  });
});

// The spawn path deliberately has no automated test: it would pull a 2.4GB
// image and start a real crawl. It is covered by the manual end-to-end run in
// the README.
describe("config resolution", () => {
  it("accepts a name with or without its extension", () => {
    writeConfig("sulnews");
    fs.writeFileSync(path.join(store.configDir, "cultprotest.yml"), "seeds: []\n");

    expect(normalizeName("sulnews.yaml")).toBe("sulnews");
    expect(normalizeName(" cultprotest.yml ")).toBe("cultprotest");
    expect(configPath(store, normalizeName("sulnews.yaml"))).toContain("sulnews.yaml");
    expect(configPath(store, "cultprotest")).toContain("cultprotest.yml");
    expect(configPath(store, "ghost")).toBeUndefined();
    expect(listConfigs(store)).toEqual(["cultprotest", "sulnews"]);
  });
});

describe("resolveTarget", () => {
  it("finds a finished run through a collection name that differs from the config", () => {
    writeConfig("sulnews", "collection: stanford-news\n");
    const run1 = path.join(store.runsDir, "sulnews-20260913T100000");
    fs.mkdirSync(path.join(run1, "collections", "stanford-news"), { recursive: true });

    const target = resolveTarget(store, monitor, "sulnews");
    expect(target).toEqual({ config: "sulnews", collection: "stanford-news", root: run1 });
  });

  it("prefers the newest run", () => {
    writeConfig("sulnews", "collection: stanford-news\n");
    for (const stamp of ["sulnews-20260913T100000", "sulnews-20260913T120000"]) {
      fs.mkdirSync(path.join(store.runsDir, stamp, "collections", "stanford-news"), { recursive: true });
    }
    expect(resolveTarget(store, monitor, "sulnews")?.root).toBe(path.join(store.runsDir, "sulnews-20260913T120000"));
  });

  it("falls back to a legacy top-level collections directory", () => {
    fs.mkdirSync(path.join(dir, "collections", "oldcrawl"), { recursive: true });
    expect(resolveTarget(store, monitor, "oldcrawl", dir)).toEqual({
      config: "oldcrawl",
      collection: "oldcrawl",
      root: dir,
    });
  });

  it("returns nothing for a config that has never run", () => {
    writeConfig("sulnews");
    expect(resolveTarget(store, monitor, "sulnews")).toBeUndefined();
  });
});

describe("btrix_status guards", () => {
  it("asks for a name when nothing is running", async () => {
    const out = said(await run(tool("btrix_status"), {}));
    expect(out).toContain("No crawl is running");
  });

  it("points at btrix_run when the config exists but has never run", async () => {
    writeConfig("sulnews");
    const out = said(await run(tool("btrix_status"), { name: "sulnews" }));
    expect(out).toContain("Nothing crawled for sulnews yet");
    expect(out).toContain("start it with btrix_run");
  });

  it("reads a run that exists", async () => {
    writeConfig("sulnews", "collection: stanford-news\n");
    const logs = path.join(store.runsDir, "sulnews-20260913T100000", "collections", "stanford-news", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "a.log"),
      JSON.stringify({ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 3, total: 8 } }) + "\n",
    );
    const result: any = await run(tool("btrix_status"), { name: "sulnews" });
    expect(said(result)).toContain("3/8 pages");
    expect(result.details.crawled).toBe(3);
    // The collection name, not the config name, is what was crawled.
    expect(result.details.name).toBe("stanford-news");
    expect(result.details.config).toBe("sulnews");
  });
});

describe("btrix_review", () => {
  const HEADER = `{"format":"json-pages-1.0","id":"pages","title":"Seed Pages","hasText":"true"}`;
  const page = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ url: "https://x.test/", title: "Home", status: 200, mime: "text/html", loadState: 4, seed: true, text: "a".repeat(3000), ...over });

  it("reviews a run's page index in place", async () => {
    writeConfig("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    const coll = path.join(store.runsDir, "sulnews-20260913T100000", "collections", "stanford-news");
    fs.mkdirSync(path.join(coll, "pages"), { recursive: true });
    fs.writeFileSync(path.join(coll, "pages", "pages.jsonl"), [HEADER, page(), page({ url: "https://x.test/b", status: 404 })].join("\n"));

    const result: any = await run(tool("btrix_review"), { name: "sulnews" });
    const out = said(result);
    expect(out).toContain("2 pages captured");
    expect(out).toContain("404 https://x.test/b");
    expect(result.details.report.total).toBe(2);
  });

  it("does not call a finished crawl partial, or name internal state", async () => {
    writeConfig("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    const coll = path.join(store.runsDir, "sulnews-20260913T100000", "collections", "stanford-news");
    fs.mkdirSync(path.join(coll, "pages"), { recursive: true });
    fs.mkdirSync(path.join(coll, "logs"), { recursive: true });
    fs.writeFileSync(path.join(coll, "pages", "pages.jsonl"), [HEADER, page()].join("\n"));
    // No wacz and no container, so nothing is running: the review is of
    // whatever was captured, and must not claim to be partial.
    const out = said(await run(tool("btrix_review"), { name: "sulnews" }));
    expect(out).not.toContain("still running");
    // And it must never surface an internal state name to the user.
    expect(out).not.toContain("no-stats");
  });

  it("falls back to the summary stored with the archive", async () => {
    writeConfig("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    fs.writeFileSync(path.join(store.outDir, "stanford-news.wacz"), Buffer.alloc(32));
    fs.writeFileSync(
      path.join(store.outDir, "stanford-news.btrix.json"),
      JSON.stringify({ config: "sulnews.yaml", review: { seedPages: 5, extraPages: 2, total: 7, hasText: true, medianTextLength: 900, hosts: [], offHost: [], statuses: [], notOk: [], mimes: [], repeatedTitles: [], thinPages: [], emptyText: 0, partialLoads: [], truncated: false } }),
    );
    const result: any = await run(tool("btrix_review"), { name: "stanford-news" });
    expect(said(result)).toContain("7 pages captured");
    expect(result.details.fromSidecar).toBe(true);
  });

  it("says plainly when there is nothing left to review", async () => {
    writeConfig("sulnews", "collection: stanford-news\ngenerateWACZ: true\n");
    fs.writeFileSync(path.join(store.outDir, "stanford-news.wacz"), Buffer.alloc(32));
    const out = said(await run(tool("btrix_review"), { name: "stanford-news" }));
    expect(out).toContain("no page index is available");
    expect(out).toContain("btrix_view");
  });

  it("asks which crawl when there are several", async () => {
    writeConfig("a", "collection: a\n");
    writeConfig("b", "collection: b\n");
    for (const n of ["a", "b"]) fs.writeFileSync(path.join(store.outDir, `${n}.wacz`), Buffer.alloc(8));
    expect(said(await run(tool("btrix_review"), {}))).toContain("Several crawls");
  });
});
