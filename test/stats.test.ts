import { describe, expect, it } from "vitest";
import { emptyFacts, foldLines, type LogFacts } from "../src/log.ts";
import { deriveState } from "../src/stats.ts";

const facts = (over: Partial<LogFacts> = {}): LogFacts => ({ ...emptyFacts(), ...over });

describe("deriveState", () => {
  it("calls it done only when a WACZ exists", () => {
    expect(deriveState({ facts: facts({ phase: "generating-wacz" }), wacz: true, containerRunning: false })).toBe(
      "done",
    );
    expect(deriveState({ facts: facts({ phase: "generating-wacz" }), wacz: false, containerRunning: true })).toBe(
      "generating-wacz",
    );
  });

  it("distinguishes a crawl that died from one that simply wrote no WACZ", () => {
    // The old plugin folded both of these into `done*`.
    expect(deriveState({ facts: facts({ phase: "post-crawl", crawled: 9 }), wacz: false, containerRunning: false })).toBe(
      "stopped",
    );
    expect(deriveState({ facts: facts({ phase: "crawling", crawled: 4 }), wacz: false, containerRunning: false })).toBe(
      "stopped",
    );
  });

  it("reports crawling only while a container is alive", () => {
    expect(deriveState({ facts: facts({ phase: "crawling", crawled: 4 }), wacz: false, containerRunning: true })).toBe(
      "crawling",
    );
    expect(deriveState({ facts: facts(), wacz: false, containerRunning: true })).toBe("no-stats");
    expect(deriveState({ facts: facts(), wacz: false, containerRunning: false })).toBe("no-stats");
  });

  it("treats a real finished crawl as stopped until its WACZ lands", () => {
    const f = foldLines([
      JSON.stringify({ context: "crawlStatus", message: "Crawl statistics", details: { crawled: 1, total: 1 } }),
      JSON.stringify({ context: "general", message: "Crawling done" }),
      JSON.stringify({ context: "general", message: "Generating WACZ" }),
    ]);
    expect(deriveState({ facts: f, wacz: false, containerRunning: true })).toBe("generating-wacz");
    expect(deriveState({ facts: f, wacz: true, containerRunning: false })).toBe("done");
  });
});
