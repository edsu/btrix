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
import { configPath, createTools, listConfigs, normalizeName } from "../src/tools.ts";

let dir: string;
let tools: ReturnType<typeof createTools>;
let monitor: CrawlMonitor;

const tool = (name: string) => tools.find((t) => t.name === name)!;
const run = (t: any, params: any) => t.execute("id", params, undefined, undefined, {} as any);
const said = (r: any) => r.content.map((c: any) => c.text).join(" ");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-tools-"));
  monitor = new CrawlMonitor({ cwd: dir });
  tools = createTools(monitor, dir);
});

afterEach(() => {
  monitor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("btrix_run guards", () => {
  it("says there are no configs rather than starting anything", async () => {
    const out = said(await run(tool("btrix_run"), { config: "nope" }));
    expect(out).toContain("No config/nope.yaml");
    expect(out).toContain("no configs yet");
  });

  it("lists the configs that do exist when the name is wrong", async () => {
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config", "sulnews.yaml"), "seeds: []\n");
    fs.writeFileSync(path.join(dir, "config", "cultprotest.yml"), "seeds: []\n");
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
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config", "sulnews.yaml"), "seeds: []\n");
    fs.writeFileSync(path.join(dir, "config", "cultprotest.yml"), "seeds: []\n");

    expect(normalizeName("sulnews.yaml")).toBe("sulnews");
    expect(normalizeName(" cultprotest.yml ")).toBe("cultprotest");
    expect(configPath(dir, normalizeName("sulnews.yaml"))).toContain("sulnews.yaml");
    // .yml is found as readily as .yaml
    expect(configPath(dir, "cultprotest")).toContain("cultprotest.yml");
    expect(configPath(dir, "ghost")).toBeUndefined();
    expect(listConfigs(dir)).toEqual(["cultprotest", "sulnews"]);
  });
});

describe("btrix_status guards", () => {
  it("asks for a name when nothing is running", async () => {
    const out = said(await run(tool("btrix_status"), {}));
    expect(out).toContain("No crawl is running");
  });

  it("says so when the collection does not exist", async () => {
    const out = said(await run(tool("btrix_status"), { name: "ghost" }));
    expect(out).toContain("No collections/ghost");
  });

  it("reads a collection that exists", async () => {
    const logs = path.join(dir, "collections", "sulnews", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "a.log"),
      JSON.stringify({ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 3, total: 8 } }) + "\n",
    );
    const result: any = await run(tool("btrix_status"), { name: "sulnews" });
    expect(said(result)).toContain("3/8 pages");
    expect(result.details.crawled).toBe(3);
  });
});
