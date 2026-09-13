import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyFacts, foldLine, foldLines } from "../src/log.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n");

describe("foldLines over real crawl logs", () => {
  it("reads counts, version and phase from a completed crawl", () => {
    const f = foldLines(fixture("complete-with-behavior.log"));
    expect(f.crawled).toBe(1);
    expect(f.total).toBe(1);
    expect(f.failed).toBe(0);
    expect(f.pagesFinished).toBe(1);
    expect(f.version).toBe("1.14.3");
    // The log ends at WACZ generation; only a WACZ on disk means "done".
    expect(f.phase).toBe("generating-wacz");
    expect(f.lastPageFinishedAt).toBeTypeOf("string");
  });

  it("counts warnings and keeps the last problem", () => {
    const f = foldLines(fixture("complete-slow-page.log"));
    expect(f.warnings).toBe(2);
    expect(f.lastProblem).toBe("Skipping behaviors for slow page");
    expect(f.errors).toBe(0);
  });
});

describe("rate-limit counting", () => {
  // progress.sh tested `"rate limited" in line` against the whole raw JSON
  // line, so any URL or nested blob containing that text inflated the count.
  it("ignores the phrase outside the message field", () => {
    const line = JSON.stringify({
      timestamp: "2026-09-13T00:00:00.000Z",
      logLevel: "info",
      context: "worker",
      message: "Starting page",
      details: { page: "https://example.org/how-we-got-rate-limited-by-a-cdn" },
    });
    expect(foldLine(emptyFacts(), line).rateLimited).toBe(0);
  });

  it("counts it in the message field", () => {
    const line = JSON.stringify({
      timestamp: "2026-09-13T00:00:01.000Z",
      logLevel: "warn",
      context: "fetch",
      message: "Rate limited, retrying",
    });
    const f = foldLine(emptyFacts(), line);
    expect(f.rateLimited).toBe(1);
    expect(f.warnings).toBe(1);
  });
});

describe("robustness", () => {
  it("extracts pending pages from their nested JSON strings", () => {
    const line = JSON.stringify({
      context: "crawlStatus",
      message: "Crawl statistics",
      details: {
        crawled: 3,
        total: 9,
        pendingPages: [JSON.stringify({ url: "https://example.org/a", started: "2026-09-13T00:00:00.000Z" })],
      },
    });
    const f = foldLine(emptyFacts(), line);
    expect(f.pending).toBe(0);
    expect(f.pendingPages).toEqual([{ url: "https://example.org/a", started: "2026-09-13T00:00:00.000Z" }]);
  });

  it("ignores torn and empty lines, as happens while the crawler is writing", () => {
    const f = emptyFacts();
    foldLine(f, '{"context":"crawlStatus","details":{"crawled":2,"tot');
    foldLine(f, "");
    foldLine(f, "   ");
    expect(f.crawled).toBe(0);
    expect(f.phase).toBe("starting");
  });

  it("keeps the last statistics line when several appear", () => {
    const mk = (crawled: number, total: number) =>
      JSON.stringify({ context: "crawlStatus", message: "Crawl statistics", details: { crawled, total } });
    const f = foldLines([mk(1, 10), mk(4, 12), mk(7, 12)]);
    expect(f.crawled).toBe(7);
    expect(f.total).toBe(12);
    expect(f.phase).toBe("crawling");
  });
});
