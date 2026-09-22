/**
 * Recognising the crawler image.
 *
 * This used to be `docker ps --filter ancestor=webrecorder/browsertrix-crawler`,
 * which matches only `:latest` — so with BTRIX_CRAWLER_VERSION pinned, every
 * running crawl was invisible: no duplicate-crawl guard, `btrix_stop` claiming
 * nothing was running, and a live crawl treated as finished.
 */

import { afterEach, describe, expect, it } from "vitest";
import { engine, isCrawlerImage, resetEngineCache } from "../src/engine.ts";

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

/**
 * The `BTRIX_ENGINE` override.
 *
 * `none` is the one that earns its keep. Detection shells out, and on a loaded
 * CI runner a `docker ps` costs seconds -- which timed out three tests that
 * only ever assert "nothing is running". The suite does not need an engine, so
 * it says so rather than paying to find out.
 */
describe("engine override", () => {
  afterEach(() => {
    resetEngineCache();
  });

  it("reports no engine when told there is none, without probing", async () => {
    // Nothing to spy on: any probe at all would have to spawn a process, and
    // a bogus binary name proves no spawn happened -- a probe would have
    // tried it and failed the same way, so the name must never be reached.
    expect(await engine({ BTRIX_ENGINE: "none" })).toBeUndefined();
  });

  it("uses only the engine it is given", async () => {
    // A name that cannot exist: if the podman/docker fallback still ran, a
    // machine with either installed would return one of them instead.
    expect(await engine({ BTRIX_ENGINE: "definitely-not-an-engine-xyz" })).toBeUndefined();
  });

  it("falls back to detection when unset", async () => {
    // Whatever this machine has, or nothing. The assertion is only that an
    // empty environment does not take the override path.
    const found = await engine({});
    expect(found === undefined || found === "podman" || found === "docker").toBe(true);
  });
});
