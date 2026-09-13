/**
 * Questions asked directly. The point is that a question costs nothing now, so
 * the expensive mistakes can be caught at the moment they are still cheap.
 */

import { describe, expect, it, vi } from "vitest";
import type { ConfigSummary } from "../src/config.ts";
import { type Asker, confirmCrawl, describeScope, isOpenEnded, pickOne } from "../src/confirm.ts";

const config = (over: Partial<ConfigSummary> = {}): ConfigSummary => ({
  name: "sulnews",
  path: "",
  collection: "sulnews",
  seed: "https://library.stanford.edu/news",
  scopeType: "prefix",
  behaviors: [],
  generateWacz: true,
  textToPages: true,
  ...over,
});

const asker = (answers: { select?: string; confirm?: boolean } = {}): Asker & { select: any; confirm: any } => ({
  select: vi.fn().mockResolvedValue(answers.select),
  confirm: vi.fn().mockResolvedValue(answers.confirm ?? false),
});

const FIVE_GB = 5 * 1024 ** 3;

describe("describeScope", () => {
  it("says what each scope actually includes", () => {
    expect(describeScope(config({ scopeType: "page" }))).toContain("nothing else");
    expect(describeScope(config({ scopeType: "prefix" }))).toContain("beneath its path");
    // "host" reads harmlessly and does not behave that way.
    expect(describeScope(config({ scopeType: "host" }))).toBe("every page on library.stanford.edu");
    expect(describeScope(config({ scopeType: "domain" }))).toContain("and its subdomains");
    expect(describeScope(config({ scopeType: undefined }))).toContain("scope not set");
  });

  it("survives an unparseable seed", () => {
    expect(describeScope(config({ scopeType: "host", seed: "not-a-url" }))).toContain("the seed's host");
  });
});

describe("isOpenEnded", () => {
  it("is true only for a wide scope with no limit", () => {
    expect(isOpenEnded(config({ scopeType: "host" }))).toBe(true);
    expect(isOpenEnded(config({ scopeType: "domain" }))).toBe(true);
    expect(isOpenEnded(config({ scopeType: "host", pageLimit: 25 }))).toBe(false);
    expect(isOpenEnded(config({ scopeType: "prefix" }))).toBe(false);
    expect(isOpenEnded(config({ scopeType: "page" }))).toBe(false);
  });
});

describe("confirmCrawl", () => {
  it("waves through an ordinary crawl with room to spare", async () => {
    const ask = asker();
    expect(await confirmCrawl(ask, config(), 40 * 1024 ** 3, FIVE_GB)).toEqual({ proceed: true });
    expect(ask.select).not.toHaveBeenCalled();
    expect(ask.confirm).not.toHaveBeenCalled();
  });

  it("shows the scope in words before an open-ended crawl", async () => {
    const ask = asker({ select: "Crawl anyway" });
    const verdict = await confirmCrawl(ask, config({ scopeType: "host" }), 40 * 1024 ** 3, FIVE_GB);
    expect(verdict.proceed).toBe(true);
    const title = ask.select.mock.calls[0]![0] as string;
    expect(title).toContain("every page on library.stanford.edu");
    expect(title).toContain("limit   none");
    expect(title).toContain("could run for hours");
  });

  it("blocks with advice when the user declines an open-ended crawl", async () => {
    const ask = asker({ select: "Cancel and add a page limit" });
    const verdict = await confirmCrawl(ask, config({ scopeType: "host" }), 40 * 1024 ** 3, FIVE_GB);
    expect(verdict).toMatchObject({ proceed: false });
    if (!verdict.proceed) {
      expect(verdict.reason).toContain("no pageLimit");
      // The block should carry the fix, not just the refusal.
      expect(verdict.reason).toContain("25");
    }
  });

  it("treats a dismissed dialog as cancelled, not as consent", async () => {
    const ask = asker({ select: undefined });
    expect((await confirmCrawl(ask, config({ scopeType: "host" }), 40 * 1024 ** 3, FIVE_GB)).proceed).toBe(false);
  });

  it("asks about low disk before anything else, and blocks on refusal", async () => {
    const ask = asker({ confirm: false });
    const verdict = await confirmCrawl(ask, config(), 2 * 1024 ** 3, FIVE_GB);
    expect(verdict).toMatchObject({ proceed: false, reason: "not enough free disk space" });
    expect(ask.confirm.mock.calls[0]![1]).toContain("aborts outright");
  });

  it("asks both questions when both apply", async () => {
    const ask = asker({ confirm: true, select: "Crawl anyway" });
    expect(
      (await confirmCrawl(ask, config({ scopeType: "host" }), 2 * 1024 ** 3, FIVE_GB)).proceed,
    ).toBe(true);
    expect(ask.confirm).toHaveBeenCalledOnce();
    expect(ask.select).toHaveBeenCalledOnce();
  });
});

describe("pickOne", () => {
  it("does not ask when there is nothing to choose", async () => {
    const ask = asker();
    expect(await pickOne(ask, "which?", ["only"])).toBe("only");
    expect(ask.select).not.toHaveBeenCalled();
  });

  it("asks when there is", async () => {
    const ask = asker({ select: "b" });
    expect(await pickOne(ask, "which?", ["a", "b"])).toBe("b");
  });
});
