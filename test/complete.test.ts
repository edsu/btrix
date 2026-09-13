/**
 * Name completion. Names are the main thing typed here, and a typo otherwise
 * costs a model turn to find and fix.
 */

import { describe, expect, it } from "vitest";
import {
  applyNameCompletion,
  filterSuggestions,
  fuzzyMatches,
  nameSuggestions,
  tokenBeforeCursor,
} from "../src/complete.ts";

const inv = (over: Record<string, any> = {}): any => ({
  store: { root: "/w/btrix" },
  configs: [
    { name: "sulnews", collection: "stanford-news", seed: "https://library.stanford.edu/news", scopeType: "prefix", behaviors: [], generateWacz: true, textToPages: true, path: "" },
    { name: "cultprotest", collection: "cultprotest", seed: "https://cultprotest.me/", scopeType: "page", behaviors: [], generateWacz: true, textToPages: false, path: "" },
  ],
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

describe("tokenBeforeCursor", () => {
  it("finds an @token at the cursor", () => {
    expect(tokenBeforeCursor("crawl @sul")).toBe("sul");
    expect(tokenBeforeCursor("@")).toBe("");
    expect(tokenBeforeCursor('replay ("@stan')).toBe("stan");
  });

  it("ignores text with no token, and email-looking things", () => {
    expect(tokenBeforeCursor("crawl sulnews")).toBeUndefined();
    // No boundary before the @, so this is not a completion request.
    expect(tokenBeforeCursor("mail ed@example.org")).toBeUndefined();
  });
});

describe("nameSuggestions", () => {
  it("offers configs with their seed and scope as context", () => {
    const items = nameSuggestions(inv());
    expect(items.map((i) => i.value)).toContain("sulnews");
    expect(items.find((i) => i.value === "sulnews")!.description).toContain("library.stanford.edu/news");
    expect(items.find((i) => i.value === "sulnews")!.description).toContain("prefix");
  });

  it("offers a collection name that differs from its config", () => {
    // The output is called stanford-news, so that is worth completing too.
    const items = nameSuggestions(inv());
    expect(items.find((i) => i.value === "stanford-news")!.description).toContain("collection of sulnews");
  });

  it("puts archives first, since they are what exists", () => {
    const items = nameSuggestions(
      inv({ archives: [{ collection: "stanford-news", kind: "wacz", bytes: 1024, path: "", provenance: { pages: { crawled: 9, total: 9 } } }] }),
    );
    expect(items[0]!.value).toBe("stanford-news");
    expect(items[0]!.description).toContain("archive");
    expect(items[0]!.description).toContain("9/9 pages");
  });

  it("does not offer the same name twice", () => {
    const items = nameSuggestions(
      inv({ archives: [{ collection: "cultprotest", kind: "wacz", bytes: 10, path: "" }] }),
    );
    expect(items.filter((i) => i.value === "cultprotest")).toHaveLength(1);
  });

  it("includes login profiles", () => {
    const items = nameSuggestions(inv(), [
      { name: "example.org", path: "", bytes: 2048, configValue: "/crawls/profiles/example.org.tar.gz" },
    ]);
    expect(items.find((i) => i.value === "example.org")!.description).toContain("login profile");
  });
});

describe("filtering", () => {
  it("matches a subsequence", () => {
    expect(fuzzyMatches("sulnews", "sn")).toBe(true);
    expect(fuzzyMatches("sulnews", "sulnews")).toBe(true);
    expect(fuzzyMatches("sulnews", "xyz")).toBe(false);
    expect(fuzzyMatches("sulnews", "")).toBe(true);
  });

  it("lifts prefix matches above mere subsequence matches", () => {
    const items = nameSuggestions(inv());
    // "c" is a prefix of cultprotest and a subsequence of stanford-news.
    expect(filterSuggestions(items, "c")[0]!.value).toBe("cultprotest");
  });
});

describe("applyNameCompletion", () => {
  it("replaces the token and drops the trigger", () => {
    // The @ is only a trigger; leaving it would just have to be stripped again
    // by whatever tool receives the name.
    const out = applyNameCompletion(["crawl @sul"], 0, 10, "sulnews", "@sul");
    expect(out.lines[0]).toBe("crawl sulnews");
    expect(out.cursorCol).toBe("crawl sulnews".length);
  });

  it("keeps text after the cursor", () => {
    const out = applyNameCompletion(["crawl @sul now"], 0, 10, "sulnews", "@sul");
    expect(out.lines[0]).toBe("crawl sulnews now");
  });

  it("leaves other lines alone", () => {
    const out = applyNameCompletion(["first", "crawl @s"], 1, 8, "sulnews", "@s");
    expect(out.lines[0]).toBe("first");
    expect(out.lines[1]).toBe("crawl sulnews");
  });

  it("appends rather than corrupting when the prefix does not match", () => {
    const out = applyNameCompletion(["crawl "], 0, 6, "sulnews", "@zzz");
    expect(out.lines[0]).toBe("crawl sulnews");
  });
});
