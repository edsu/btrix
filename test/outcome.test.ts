/**
 * The marker a promoted run leaves behind.
 *
 * Without it, a run directory whose archive has been moved into out/ looks
 * exactly like a crawl that never finished packaging — which is how a
 * completed crawl came to sit in the widget claiming to be writing its wacz.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishRun } from "../src/finish.ts";
import { promotedArchive, readOutcomeMarker } from "../src/outcome.ts";
import { CrawlTailer } from "../src/stats.ts";
import { ensureStore, prepareRun, resolveStore, type Store } from "../src/store.ts";

let dir: string;
let store: Store;

const stats = (): any => ({
  name: "inkdroid",
  state: "done",
  phase: "generating-wacz",
  containerRunning: false,
  crawled: 4,
  total: 4,
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
});

/** A run whose log ends at "Generating WACZ", with the archive written. */
function finishedRun(withWacz = true): string {
  const root = prepareRun(store, "inkdroid", new Date(2026, 8, 13, 10, 0, 0));
  const coll = path.join(root, "collections", "inkdroid");
  fs.mkdirSync(path.join(coll, "logs"), { recursive: true });
  fs.mkdirSync(path.join(coll, "archive"), { recursive: true });
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    path.join(coll, "logs", "a.log"),
    line({ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 4, total: 4 } }) +
      line({ context: "general", message: "Crawling done" }) +
      line({ context: "general", message: "Generating WACZ" }),
  );
  if (withWacz) fs.writeFileSync(path.join(coll, "inkdroid.wacz"), Buffer.alloc(202 * 1024));
  return root;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-outcome-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
  fs.writeFileSync(path.join(store.configDir, "inkdroid.yaml"), "collection: inkdroid\ngenerateWACZ: true\n");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("promotion leaves a marker", () => {
  it("keeps a promoted run reading as done, not as still packaging", async () => {
    const root = finishedRun();
    expect((await new CrawlTailer("inkdroid", root, "inkdroid").read(1_000_000)).state).toBe("done");

    const outcome = await finishRun(store, { config: "inkdroid", collection: "inkdroid", root }, stats());
    expect(outcome.kind).toBe("promoted");

    // The archive is no longer where the crawler wrote it.
    expect(fs.existsSync(path.join(root, "collections", "inkdroid", "inkdroid.wacz"))).toBe(false);

    const after = await new CrawlTailer("inkdroid", root, "inkdroid").read(1_010_000);
    expect(after.state).toBe("done");
    // And it points at the archive's real location, not a path that is gone.
    expect(after.waczPath).toBe(outcome.dest);

    const marker = readOutcomeMarker(root)!;
    expect(marker).toMatchObject({ kind: "promoted", dest: outcome.dest });
    expect(promotedArchive(root)).toBe(outcome.dest);
  });

  it("reports stopped, not done, when the archive has since been deleted", async () => {
    const root = finishedRun();
    const outcome = await finishRun(store, { config: "inkdroid", collection: "inkdroid", root }, stats());
    fs.rmSync(outcome.dest!);

    // The marker must not be taken as proof the file is there.
    expect(promotedArchive(root)).toBeUndefined();
    expect((await new CrawlTailer("inkdroid", root, "inkdroid").read(1_020_000)).state).toBe("stopped");
  });

  it("records a run that produced nothing, and travels with it to failed/", async () => {
    const root = finishedRun(false);
    fs.rmSync(path.join(root, "collections", "inkdroid", "archive"), { recursive: true });
    const outcome = await finishRun(store, { config: "inkdroid", collection: "inkdroid", root }, stats());

    expect(outcome.kind).toBe("failed");
    expect(readOutcomeMarker(outcome.parked!)).toMatchObject({ kind: "failed" });
    expect(promotedArchive(outcome.parked!)).toBeUndefined();
  });

  it("survives a missing or unreadable marker", () => {
    expect(readOutcomeMarker(path.join(dir, "nowhere"))).toBeUndefined();
    const root = prepareRun(store, "x", new Date(2026, 8, 13, 10, 0, 0));
    fs.writeFileSync(path.join(root, ".btrix-outcome.json"), "{ not json");
    expect(readOutcomeMarker(root)).toBeUndefined();
  });
});
