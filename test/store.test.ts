/**
 * Store resolution, run directories, and the collection-name fix.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeRun,
  collectionFor,
  ensureStore,
  legacyRoot,
  prepareRun,
  resolveStore,
  runId,
  runsFor,
  STORE_GITIGNORE,
} from "../src/store.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-store-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveStore", () => {
  it("defaults to ./btrix in the working directory", () => {
    const s = resolveStore({ cwd: dir, env: {} });
    expect(s.root).toBe(path.join(dir, "btrix"));
    expect(s.source).toBe("default");
    expect(s.configDir).toBe(path.join(dir, "btrix", "config"));
    expect(s.outDir).toBe(path.join(dir, "btrix", "out"));
  });

  it("notices an existing store", () => {
    fs.mkdirSync(path.join(dir, "btrix"));
    expect(resolveStore({ cwd: dir, env: {} }).source).toBe("existing");
  });

  it("prefers --dir over the environment, and names the root itself", () => {
    const s = resolveStore({ dir: "/Volumes/archive/sulnews", cwd: dir, env: { BTRIX_DIR: "/elsewhere" } });
    // Not /Volumes/archive/sulnews/btrix: --dir IS the store.
    expect(s.root).toBe("/Volumes/archive/sulnews");
    expect(s.source).toBe("flag");
  });

  it("falls back to BTRIX_DIR, resolved against the cwd", () => {
    const s = resolveStore({ cwd: dir, env: { BTRIX_DIR: "scratch/store" } });
    expect(s.root).toBe(path.join(dir, "scratch", "store"));
    expect(s.source).toBe("env");
  });
});

describe("ensureStore", () => {
  it("creates the tree and a self-ignoring .gitignore", () => {
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    for (const d of [s.configDir, s.runsDir, s.outDir, s.profilesDir, s.failedDir]) {
      expect(fs.existsSync(d)).toBe(true);
    }
    const ignore = fs.readFileSync(path.join(s.root, ".gitignore"), "utf8");
    expect(ignore).toBe(STORE_GITIGNORE);
    // Credentials and bulk output are ignored; authored configs are not.
    expect(ignore).toContain("profiles/");
    expect(ignore).toContain("out/");
    expect(ignore).not.toMatch(/^config\/$/m);
  });

  it("keeps profiles private", () => {
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    expect(fs.statSync(s.profilesDir).mode & 0o777).toBe(0o700);
  });

  it("keeps an edited .gitignore, but adds back what protects credentials", () => {
    // Leaving a hand-written file untouched was the old behaviour, and it
    // meant profiles/ went unignored -- so `git add -A` could publish live
    // session cookies, which is the one thing this file exists to stop.
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    const file = path.join(s.root, ".gitignore");

    fs.writeFileSync(file, "# mine\nout/\n");
    ensureStore(s);
    const after = fs.readFileSync(file, "utf8");

    expect(after).toContain("# mine");
    expect(after).toContain("profiles/");
    expect(after).toContain("chrome-profile/");
    // Already present, so not added a second time.
    expect(after.match(/^out\/$/gm)).toHaveLength(1);
  });

  it("adds nothing when every entry is already there", () => {
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    const file = path.join(s.root, ".gitignore");
    const first = fs.readFileSync(file, "utf8");

    ensureStore(s);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("copes with a file that has no trailing newline", () => {
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    const file = path.join(s.root, ".gitignore");

    fs.writeFileSync(file, "# no newline at eof");
    ensureStore(s);
    const lines = fs.readFileSync(file, "utf8").split("\n");

    expect(lines[0]).toBe("# no newline at eof");
    expect(lines).toContain("profiles/");
  });
});

describe("run directories", () => {
  it("stamps a sortable run id", () => {
    expect(runId("sulnews", new Date(2026, 8, 13, 11, 37, 5))).toBe("sulnews-20260913T113705");
  });

  it("copies the config directory in, so the container can see it", () => {
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    fs.writeFileSync(path.join(s.configDir, "sulnews.yaml"), "collection: stanford-news\n");
    fs.mkdirSync(path.join(s.configDir, "behaviors"));
    fs.writeFileSync(path.join(s.configDir, "behaviors", "more.js"), "// load more\n");

    const run = prepareRun(s, "sulnews", new Date(2026, 8, 13, 11, 37, 5));
    expect(fs.readFileSync(path.join(run, "config", "sulnews.yaml"), "utf8")).toContain("stanford-news");
    // customBehaviors paths like /crawls/config/behaviors/more.js keep working.
    expect(fs.existsSync(path.join(run, "config", "behaviors", "more.js"))).toBe(true);
  });

  it("lists runs newest first and finds the one with output", () => {
    const s = ensureStore(resolveStore({ cwd: dir, env: {} }));
    const older = prepareRun(s, "sulnews", new Date(2026, 8, 13, 10, 0, 0));
    const newer = prepareRun(s, "sulnews", new Date(2026, 8, 13, 12, 0, 0));
    prepareRun(s, "other", new Date(2026, 8, 13, 13, 0, 0));

    expect(runsFor(s, "sulnews")).toEqual([newer, older]);
    expect(activeRun(s, "sulnews", "stanford-news")).toBeUndefined();

    fs.mkdirSync(path.join(older, "collections", "stanford-news"), { recursive: true });
    expect(activeRun(s, "sulnews", "stanford-news")).toBe(older);
  });
});

describe("collectionFor", () => {
  // A config named sulnews.yaml can declare `collection: stanford-news`, and
  // then looking in collections/sulnews finds nothing, forever.
  it("reads the collection key when it differs from the filename", () => {
    const f = path.join(dir, "sulnews.yaml");
    fs.writeFileSync(f, "collection: stanford-news\ngenerateWACZ: true\n");
    expect(collectionFor(f, "sulnews")).toBe("stanford-news");
  });

  it("strips quotes", () => {
    const f = path.join(dir, "a.yaml");
    fs.writeFileSync(f, `collection: "my-crawl"\n`);
    expect(collectionFor(f, "a")).toBe("my-crawl");
  });

  it("falls back to the filename when the key is absent, commented or unreadable", () => {
    const absent = path.join(dir, "b.yaml");
    fs.writeFileSync(absent, "seeds:\n  - url: https://example.com/\n");
    expect(collectionFor(absent, "b")).toBe("b");

    const commented = path.join(dir, "c.yaml");
    fs.writeFileSync(commented, "collection: # set me later\n");
    expect(collectionFor(commented, "c")).toBe("c");

    expect(collectionFor(path.join(dir, "missing.yaml"), "missing")).toBe("missing");
  });
});

describe("legacyRoot", () => {
  it("recognises a top-level collections directory", () => {
    expect(legacyRoot(dir)).toBeUndefined();
    fs.mkdirSync(path.join(dir, "collections"));
    expect(legacyRoot(dir)).toBe(dir);
  });
});
