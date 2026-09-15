/**
 * The page-index analyser. Fixtures are shaped like real pages.jsonl, including
 * its format header line.
 */

import { describe, expect, it } from "vitest";
import { analyzePages, parsePagesJsonl, type PageRecord } from "../src/pages.ts";
import { renderReview, reviewForModel } from "../src/render.ts";

const HEADER = `{"format":"json-pages-1.0","id":"pages","title":"Seed Pages","hasText":"true"}`;

const page = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "x",
    url: "https://library.stanford.edu/news",
    title: "News | University Libraries",
    loadState: 4,
    ts: "2026-09-03T19:22:36.262Z",
    mime: "text/html",
    status: 200,
    seed: true,
    depth: 0,
    text: "a".repeat(4000),
    ...over,
  });

const report = (seed: string[], extra: string[] = []) =>
  analyzePages({
    seed: parsePagesJsonl([HEADER, ...seed].join("\n")),
    extra: parsePagesJsonl(extra.length ? [HEADER, ...extra].join("\n") : ""),
    found: true,
  });

describe("parsePagesJsonl", () => {
  it("skips the format header rather than counting it as a page", () => {
    const pages = parsePagesJsonl([HEADER, page()].join("\n"));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.url).toBe("https://library.stanford.edu/news");
    expect(pages[0]!.textLength).toBe(4000);
    expect(pages[0]!.status).toBe(200);
  });

  it("tolerates torn and malformed lines", () => {
    expect(parsePagesJsonl([HEADER, "{oops", "", page()].join("\n"))).toHaveLength(1);
  });

  it("leaves textLength undefined when the crawl captured no text", () => {
    const pages = parsePagesJsonl([HEADER, page({ text: undefined })].join("\n"));
    expect(pages[0]!.textLength).toBeUndefined();
  });
});

describe("analyzePages", () => {
  it("counts seed and discovered pages separately", () => {
    const r = report([page(), page({ url: "https://library.stanford.edu/news/a" })], [
      page({ url: "https://library.stanford.edu/news/b", seed: false }),
    ]);
    expect(r).toMatchObject({ seedPages: 2, extraPages: 1, total: 3 });
  });

  it("says when no text was captured, rather than calling every page empty", () => {
    // A crawl without `text: to-pages` has no text for any page; reporting
    // that as "3 empty pages" would be a false alarm.
    const r = report([page({ text: undefined }), page({ text: undefined, url: "https://x.test/2" })]);
    expect(r.hasText).toBe(false);
    expect(r.emptyText).toBe(0);
    expect(r.thinPages).toEqual([]);
    const out = reviewForModel("c", r);
    expect(out).toContain("without `text: to-pages`");
    expect(out).toContain("not be searchable");
  });

  it("surfaces thin pages relative to the crawl's own median", () => {
    const fat = Array.from({ length: 8 }, (_, i) => page({ url: `https://x.test/${i}`, text: "a".repeat(8000) }));
    const r = report([...fat, page({ url: "https://x.test/block", title: "Just a moment...", text: "a".repeat(150) })]);

    expect(r.medianTextLength).toBe(8000);
    expect(r.maxTextLength).toBe(8000);
    expect(r.thinPages).toHaveLength(1);
    expect(r.thinPages[0]!.url).toBe("https://x.test/block");
    // Candidates, with numbers, not a verdict.
    const out = reviewForModel("c", r);
    expect(out).toContain("median 8000 chars, longest 8000 chars");
    expect(out).toContain("judge whether these are real content or a block page");
    expect(out).toContain("150 chars");
  });

  it("still finds interstitials when they are the majority", () => {
    // Bot mitigation catching most of a crawl makes the interstitial the
    // median, so comparing against the median would hide it.
    const blocked = Array.from({ length: 9 }, (_, i) =>
      page({ url: `https://x.test/b${i}`, title: "Just a moment...", text: "a".repeat(450) }),
    );
    const real = Array.from({ length: 3 }, (_, i) => page({ url: `https://x.test/r${i}`, text: "a".repeat(9000) }));
    const r = report([...real, ...blocked]);

    expect(r.medianTextLength).toBe(450);
    expect(r.thinPages.length).toBeGreaterThan(0);
    const out = reviewForModel("c", r);
    expect(out).toContain("longest 9000 chars");
    expect(out).toContain("did not capture real content");
  });

  it("does not flag a site whose pages are all genuinely short", () => {
    const shorts = Array.from({ length: 6 }, (_, i) => page({ url: `https://x.test/${i}`, text: "a".repeat(300) }));
    expect(report(shorts).thinPages).toEqual([]);
  });

  it("is not thrown off by one unusually long page", () => {
    // A plain maximum as the reference would flag every ordinary page here.
    const ordinary = Array.from({ length: 19 }, (_, i) => page({ url: `https://x.test/${i}`, text: "a".repeat(3000) }));
    const essay = page({ url: "https://x.test/essay", text: "a".repeat(50_000) });
    expect(report([...ordinary, essay]).thinPages).toEqual([]);
  });

  it("groups repeated titles, the interstitial signature", () => {
    const blocked = Array.from({ length: 4 }, (_, i) =>
      page({ url: `https://x.test/${i}`, title: "Just a moment...", text: "a".repeat(200) }),
    );
    const r = report([...blocked, page({ url: "https://x.test/real", title: "Real page" })]);
    expect(r.repeatedTitles[0]).toMatchObject({ title: "Just a moment...", count: 4 });
    expect(r.repeatedTitles[0]!.sample[0]).toBe("https://x.test/0");
    // Ambiguity stated, not resolved.
    expect(reviewForModel("c", r)).toContain("so does a templated site");
  });

  it("reports statuses and non-2xx pages", () => {
    const r = report([page(), page({ url: "https://x.test/gone", status: 404 }), page({ url: "https://x.test/e", status: 500 })]);
    expect(r.statuses.map((s) => s.value).sort()).toEqual([200, 404, 500]);
    expect(r.notOk).toHaveLength(2);
    expect(reviewForModel("c", r)).toContain("404 ‹https://x.test/gone›");
  });

  it("notices a scope wider than the seed host", () => {
    const r = report([page(), page({ url: "https://cdn.elsewhere.test/a" })]);
    expect(r.seedHost).toBe("library.stanford.edu");
    expect(r.offHost).toHaveLength(1);
    expect(reviewForModel("c", r)).toContain("wider than intended");
  });

  it("notices pages that did not fully load", () => {
    const r = report([page(), page({ url: "https://x.test/slow", loadState: 2 })]);
    expect(r.partialLoads).toHaveLength(1);
    expect(reviewForModel("c", r)).toContain("loadState 2");
  });

  it("counts every match, not just the sample it keeps", () => {
    // The samples are capped, so reporting their length turns "20 of 21 pages
    // were blocked" into "8 non-2xx pages" — the opposite of the judgement a
    // review exists to support.
    const blocked = Array.from({ length: 20 }, (_, i) =>
      page({ url: `https://x.test/${i}`, status: 403, loadState: 2 }),
    );
    const r = report([page(), ...blocked]);

    expect(r.notOk).toHaveLength(8);
    expect(r.totals?.notOk).toBe(20);
    expect(r.totals?.partialLoads).toBe(20);

    const forModel = reviewForModel("c", r);
    expect(forModel).toContain("20 non-2xx page(s) (first 8 shown)");
    expect(forModel).toContain("20 page(s) did not fully load");
    expect(renderReview("c", r).join("\n")).toContain("20 non-2xx page(s)");
  });

  it("survives a collection with no page index", () => {
    const r = analyzePages({ seed: [], extra: [], found: false });
    expect(r.total).toBe(0);
    expect(r.hasText).toBe(false);
    expect(() => reviewForModel("c", r)).not.toThrow();
  });
});
