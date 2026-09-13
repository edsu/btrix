import { describe, expect, it } from "vitest";
import { plainTheme, renderForModel, renderWidget, startupLines } from "../src/render.ts";
import type { CrawlStats } from "../src/stats.ts";
import { humanBytes, humanDuration } from "../src/sizes.ts";

const stats = (over: Partial<CrawlStats> = {}): CrawlStats => ({
  name: "mysite",
  state: "crawling",
  phase: "crawling",
  containerRunning: true,
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
    configs: [{ name: "sulnews", collection: "stanford-news", behaviors: [], generateWacz: true, textToPages: true, path: "", }],
    runs: [],
    archives: [],
    failed: { count: 0 },
    profiles: [],
    free: 39 * 1024 ** 3,
    running: [],
    legacyCollections: [],
    neverRun: [],
    orphans: [],
    ...over,
  });

  it("orients in a couple of lines: where, how much room, what is here", () => {
    const out = startupLines({ inv: inv(), engine: { usable: true, bin: "docker" }, adopted: [] }, plainTheme).join("\n");
    expect(out).toContain("/w/btrix");
    expect(out).toContain("39G free");
    expect(out).toContain("1 config");
  });

  it("leads with a missing container engine, since nothing works without one", () => {
    const out = startupLines(
      { inv: inv(), engine: { usable: false, problem: "No docker or podman found." }, adopted: [] },
      plainTheme,
    ).join("\n");
    // Better here than several minutes into an image pull.
    expect(out).toContain("No docker or podman found.");
  });

  it("calls out a crawl still running from an earlier session", () => {
    const out = startupLines({ inv: inv(), engine: { usable: true }, adopted: ["sulnews"] }, plainTheme).join("\n");
    expect(out).toContain("still crawling: sulnews");
  });

  it("mentions space quietly held by failed runs, and low disk", () => {
    const out = startupLines(
      { inv: inv({ failed: { count: 3, bytes: 2.1 * 1024 ** 3 }, free: 2 * 1024 ** 3 }), engine: { usable: true }, adopted: [] },
      plainTheme,
    ).join("\n");
    expect(out).toContain("3 failed run(s) holding 2.1G");
    expect(out).toContain("less than 5G free");
  });

  it("invites a first crawl when the store is empty", () => {
    const out = startupLines({ inv: inv({ configs: [] }), engine: { usable: true }, adopted: [] }, plainTheme).join("\n");
    expect(out).toContain("nothing here yet");
  });

  it("stays short", () => {
    // Every line here is a line of transcript the user does not get.
    const out = startupLines({ inv: inv(), engine: { usable: true }, adopted: [] }, plainTheme);
    expect(out.length).toBeLessThanOrEqual(3);
  });
});
