import { describe, expect, it } from "vitest";
import {
  nextStepHint,
  overviewLines,
  plainTheme,
  renderForModel,
  renderWidget,
  startupLines,
  supportsUnicode,
} from "../src/render.ts";
import type { CrawlStats } from "../src/stats.ts";
import { humanBytes, humanDuration } from "../src/sizes.ts";

const stats = (over: Partial<CrawlStats> = {}): CrawlStats => ({
  name: "mysite",
  state: "crawling",
  phase: "crawling",
  containerRunning: true,
  containerKnown: true,
  crawled: 142,
  total: 201,
  failed: 0,
  excluded: 0,
  rateLimited: 0,
  limitHit: false,
  warnings: 0,
  errors: 0,
  pending: [],
  bytes: { archive: 880 * 1024 ** 2 },
  free: 12 * 1024 ** 3,
  discovering: false,
  windowMs: 60_000,
  ...over,
});

describe("renderWidget", () => {
  it("states facts and never diagnoses a stall", () => {
    const lines = renderWidget(stats({ sinceLastPage: 4 * 60_000 }), plainTheme).join("\n");
    expect(lines).toContain("no new page 4m");
    expect(lines.toLowerCase()).not.toContain("stall");
    expect(lines.toLowerCase()).not.toContain("hung");
  });

  it("says when the total is still growing, so a falling percent makes sense", () => {
    expect(renderWidget(stats({ discovering: true }), plainTheme).join("\n")).toContain("still discovering");
    expect(renderWidget(stats({ discovering: false }), plainTheme).join("\n")).toContain("71%");
  });

  it("reports the browser profile apart from the archive", () => {
    const out = renderWidget(stats({ bytes: { archive: 1024 ** 3, profile: 300 * 1024 ** 2 } }), plainTheme).join("\n");
    expect(out).toContain("archive 1.0G");
    expect(out).toContain("profile 300M");
  });

  it("warns about the disk only when it is about to matter", () => {
    const soon = stats({ free: 500 * 1024 ** 2, bytesPerMin: 200 * 1024 ** 2, diskFullIn: 150_000 });
    expect(renderWidget(soon, plainTheme).join("\n")).toContain("full in ~2m");
    expect(renderWidget(stats({ diskFullIn: 40 * 24 * 3600_000 }), plainTheme).join("\n")).not.toContain("full in");
  });

  it("does not report rates for a crawl that is not running", () => {
    // A write rate for a dead crawl is a fact about the past dressed as the
    // present.
    const dead = stats({ state: "stopped", containerRunning: false, pagesPerMin: 3.2, bytesPerMin: 1.2 * 1024 ** 2 });
    const out = renderWidget(dead, plainTheme).join("\n");
    expect(out).not.toContain("/min");
    expect(renderForModel(dead)).not.toContain("pages/min");
    // And no disk ETA either, since nothing is filling it.
    expect(
      renderWidget(stats({ state: "stopped", containerRunning: false, diskFullIn: 120_000 }), plainTheme).join("\n"),
    ).not.toContain("full in");
  });

  it("shows both names when the collection differs from the config", () => {
    const diverged = stats({ name: "stanford-news", config: "sulnews" });
    expect(renderWidget(diverged, plainTheme).join("\n")).toContain("sulnews → stanford-news");
    expect(renderForModel(diverged)).toContain("sulnews → stanford-news");
    // No arrow when they agree.
    expect(renderWidget(stats({ name: "mysite", config: "mysite" }), plainTheme).join("\n")).not.toContain("→");
  });

  it("drops the screencast hint once the crawl is not running", () => {
    expect(renderWidget(stats(), plainTheme).join("\n")).toContain("screencast :9037");
    expect(renderWidget(stats({ state: "done", containerRunning: false }), plainTheme).join("\n")).not.toContain(
      "screencast",
    );
  });
});

describe("renderForModel", () => {
  it("carries the facts a diagnosis needs, compactly", () => {
    const out = renderForModel(
      stats({ rateLimited: 3, failed: 2, sinceLastPage: 300_000, pagesPerMin: 3.2, discovering: true }),
    );
    expect(out).toContain("mysite: crawling");
    expect(out).toContain("142/201 pages (total still growing)");
    expect(out).toContain("rate-limited 3");
    expect(out).toContain("failed 2");
    expect(out).toContain("last page completed 5m ago");
    expect(out.length).toBeLessThan(400);
  });

  it("explains an early exit rather than leaving the model to guess", () => {
    expect(renderForModel(stats({ state: "stopped", containerRunning: false }))).toContain("ended early");
  });

  it("flags rates derived from too little history", () => {
    expect(renderForModel(stats({ windowMs: 4_000, pagesPerMin: 60 }))).toContain("<30s of history");
  });
});

describe("formatting", () => {
  it("formats bytes like the scripts it replaces", () => {
    expect(humanBytes(0)).toBe("0B");
    expect(humanBytes(900)).toBe("900B");
    expect(humanBytes(1536)).toBe("1.5K");
    expect(humanBytes(880 * 1024 ** 2)).toBe("880M");
    expect(humanBytes(undefined)).toBe("-");
  });

  it("formats durations", () => {
    expect(humanDuration(45_000)).toBe("45s");
    expect(humanDuration(4 * 60_000)).toBe("4m");
    expect(humanDuration(2 * 3600_000 + 10 * 60_000)).toBe("2h10m");
    expect(humanDuration(3 * 24 * 3600_000)).toBe("3d");
    expect(humanDuration(undefined)).toBe("-");
  });
});

describe("startupLines", () => {
  const inv = (over: Record<string, any> = {}): any => ({
    store: { root: "/w/btrix" },
    configs: [{ name: "sulnews", collection: "stanford-news", behaviors: [], generateWacz: true, textToPages: true, path: "" }],
    runs: [],
    archives: [],
    failed: { count: 0 },
    profiles: [],
    free: 39 * 1024 ** 3,
    running: [],
    legacyCollections: [],
    neverRun: ["sulnews"],
    orphans: [],
    ...over,
  });
  const banner = (over: Record<string, any> = {}, invOver: Record<string, any> = {}) =>
    startupLines({ inv: inv(invOver), engine: { usable: true }, adopted: [], ...over }, plainTheme).join("\n");

  it("greets, and says what this is", () => {
    const out = banner({ model: "store /w/btrix · anthropic/claude-opus-5" });
    expect(out).toContain("btrix");
    expect(out).toContain("high-fidelity web archives");
    expect(out).toContain("Browsertrix Crawler");
    // Nothing about the harness it happens to be built on.
    expect(out.toLowerCase()).not.toMatch(/\bpi\b/);
  });

  it("says where things are and what is here", () => {
    const out = banner({ model: "store /w/btrix · anthropic/claude-opus-5" });
    expect(out).toContain("/w/btrix");
    expect(out).toContain("39G free");
    expect(out).toContain("anthropic/claude-opus-5");
    expect(out).toContain("1 config");
  });

  it("pluralises properly", () => {
    const one = banner({}, { archives: [{ collection: "a", kind: "wacz", bytes: 1024, path: "" }], profiles: [{ name: "p" }] });
    expect(one).toContain("1 archive");
    expect(one).toContain("1 login profile");
    expect(one).not.toContain("(s)");

    const two = banner(
      {},
      {
        archives: [
          { collection: "a", kind: "wacz", bytes: 1024, path: "" },
          { collection: "b", kind: "wacz", bytes: 1024, path: "" },
        ],
      },
    );
    expect(two).toContain("2 archives");
  });

  it("leads with a missing container engine, since nothing works without one", () => {
    const out = startupLines(
      { inv: inv(), engine: { usable: false, problem: "No docker or podman found." }, adopted: [] },
      plainTheme,
    ).join("\n");
    expect(out).toContain("No docker or podman found.");
    // With no engine there is no point suggesting a crawl.
    expect(out).not.toContain("Ready to crawl");
  });

  it("mentions space quietly held by failed runs, and low disk", () => {
    const out = banner({}, { failed: { count: 3, bytes: 2.1 * 1024 ** 3 }, free: 2 * 1024 ** 3 });
    expect(out).toContain("3 failed runs holding 2.1G");
    expect(out).toContain("less than 5G free");
  });

  it("credits Webrecorder and links the collective", () => {
    // btrix is a front end; the crawler is their work.
    const out = banner();
    expect(out).toContain("Webrecorder builds the crawler");
    expect(out).toContain("https://opencollective.com/webrecorder");
  });

  it("falls back to plain characters when the locale is not utf-8", () => {
    // The wordmark is ASCII either way; the heart is not.
    expect(banner({ unicode: true })).toContain("♥ Webrecorder");
    const plain = banner({ unicode: false });
    expect(plain).toContain("<3 Webrecorder");
    expect(plain).not.toContain("♥");
  });

  it("stays short enough to read", () => {
    const out = startupLines({ inv: inv(), engine: { usable: true }, adopted: [] }, plainTheme);
    expect(out.length).toBeLessThanOrEqual(14);
  });
});

describe("overviewLines", () => {
  const cfg = (name: string, collection = name) => ({
    name,
    collection,
    behaviors: [],
    generateWacz: true,
    textToPages: true,
    path: "",
  });
  const inv = (over: Record<string, any> = {}): any => ({
    store: { root: "/w/btrix" },
    configs: [],
    runs: [],
    archives: [],
    failed: { count: 0 },
    profiles: [],
    running: [],
    legacyCollections: [],
    neverRun: [],
    orphans: [],
    ...over,
  });

  it("says nothing at all for an empty store", () => {
    expect(overviewLines(inv(), plainTheme)).toEqual([]);
  });

  it("shows one row per crawl, with state, counts and size", () => {
    const out = overviewLines(
      inv({
        configs: [cfg("sulnews", "stanford-news")],
        archives: [
          {
            collection: "stanford-news",
            kind: "wacz",
            bytes: 40 * 1024 ** 2,
            path: "",
            provenance: { pages: { crawled: 25, total: 25 } },
          },
        ],
      }),
      plainTheme,
    ).join("\n");
    // Both names, since a config and its collection can differ.
    expect(out).toContain("sulnews → stanford-news");
    expect(out).toContain("done");
    expect(out).toContain("25/25");
    expect(out).toContain("40M");
  });

  it("orders by what you most likely want to see", () => {
    const rows = overviewLines(
      inv({
        configs: [cfg("live"), cfg("archived"), cfg("halted"), cfg("fresh")],
        running: ["live"],
        runs: [
          { config: "live", collection: "live", root: "", stats: { crawled: 1, total: 9, state: "crawling" } },
          { config: "halted", collection: "halted", root: "", stats: { crawled: 4, total: 9, state: "stopped" } },
        ],
        archives: [{ collection: "archived", kind: "wacz", bytes: 10, path: "" }],
        neverRun: ["fresh"],
      }),
      plainTheme,
    ).map((l) => l.trim().split(/\s+/)[0]);
    // Running, then finished, then ended without an archive, then not yet run.
    expect(rows).toEqual(["live", "archived", "halted", "fresh"]);
  });

  it("includes an archive whose config has gone", () => {
    const out = overviewLines(
      inv({ archives: [{ collection: "renamed", kind: "wacz", bytes: 1024, path: "" }] }),
      plainTheme,
    ).join("\n");
    expect(out).toContain("renamed");
    expect(out).toContain("no config");
  });

  it("caps the list and says how much it left out", () => {
    const out = overviewLines(inv({ configs: Array.from({ length: 9 }, (_, i) => cfg(`c${i}`)) }), plainTheme, 3);
    expect(out).toHaveLength(4);
    expect(out[3]).toContain("+6 more");
    expect(out[3]).toContain("/btrix");
  });

  it("leaves no trailing whitespace on a sparse row", () => {
    const out = overviewLines(inv({ configs: [cfg("fresh")], neverRun: ["fresh"] }), plainTheme);
    for (const line of out) expect(line).toBe(line.replace(/\s+$/, ""));
  });
});

describe("nextStepHint", () => {
  const base: any = { archives: [], neverRun: [], store: { root: "." } };

  it("invites a first crawl when there is nothing at all", () => {
    expect(nextStepHint(base, [])).toContain("Tell me a site to archive");
  });

  it("names a config that is ready to run", () => {
    expect(nextStepHint({ ...base, neverRun: ["sulnews"] }, [])).toContain('say "crawl sulnews"');
  });

  it("points at an archive once one exists", () => {
    expect(nextStepHint({ ...base, archives: [{ collection: "stanford-news" }] }, [])).toContain(
      'Say "replay stanford-news"',
    );
  });

  it("prefers telling you about a crawl in flight", () => {
    expect(nextStepHint({ ...base, neverRun: ["other"] }, ["sulnews"])).toContain("sulnews is still crawling");
  });
});

describe("supportsUnicode", () => {
  it("trusts a utf-8 locale and known terminals", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(supportsUnicode({ LC_ALL: "C.utf8" })).toBe(true);
    expect(supportsUnicode({ TERM_PROGRAM: "vscode" })).toBe(true);
  });

  it("does not assume it otherwise", () => {
    expect(supportsUnicode({ LANG: "C" })).toBe(false);
    expect(supportsUnicode({})).toBe(false);
  });
});
