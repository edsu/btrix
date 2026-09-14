/**
 * Recognising the crawler image.
 *
 * This used to be `docker ps --filter ancestor=webrecorder/browsertrix-crawler`,
 * which matches only `:latest` — so with BTRIX_CRAWLER_VERSION pinned, every
 * running crawl was invisible: no duplicate-crawl guard, `btrix_stop` claiming
 * nothing was running, and a live crawl treated as finished.
 */

import { describe, expect, it } from "vitest";
import { isCrawlerImage } from "../src/engine.ts";

describe("isCrawlerImage", () => {
  it("matches the image whatever tag it carries", () => {
    expect(isCrawlerImage("webrecorder/browsertrix-crawler")).toBe(true);
    expect(isCrawlerImage("webrecorder/browsertrix-crawler:latest")).toBe(true);
    expect(isCrawlerImage("webrecorder/browsertrix-crawler:1.14.4")).toBe(true);
    expect(isCrawlerImage("webrecorder/browsertrix-crawler:v1.7.0-beta.1")).toBe(true);
  });

  it("matches the fully-qualified names podman reports", () => {
    expect(isCrawlerImage("docker.io/webrecorder/browsertrix-crawler:1.14.4")).toBe(true);
    expect(isCrawlerImage("docker.io/webrecorder/browsertrix-crawler")).toBe(true);
  });

  it("matches a digest pin", () => {
    expect(isCrawlerImage("webrecorder/browsertrix-crawler@sha256:" + "a".repeat(64))).toBe(true);
  });

  it("does not match other images", () => {
    expect(isCrawlerImage("webrecorder/browsertrix-crawler-other:latest")).toBe(false);
    expect(isCrawlerImage("someoneelse/browsertrix-crawler:latest")).toBe(false);
    expect(isCrawlerImage("postgres:16")).toBe(false);
    expect(isCrawlerImage("")).toBe(false);
  });
});
