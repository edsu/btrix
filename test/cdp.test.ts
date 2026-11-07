/**
 * The DevTools client against a real headless Chrome, skipped where none is
 * installed.
 *
 * An expression that never finishes used to leave the tab running it: the
 * client gave up and exited, and a busy loop kept the page's main thread, so
 * every later call timed out too. Only the connection that started an
 * evaluation can stop it -- a fresh one sent Runtime.terminateExecution and got
 * no answer -- so the client has to stop it before it leaves.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/cdp.ts";
import { findChrome, launchChrome, type LocalChrome } from "../src/localchrome.ts";

const chrome = await findChrome();

describe.skipIf(!chrome)("evaluating in a real Chrome", () => {
  let browser: LocalChrome;
  let profile: string;

  beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-cdp-"));
    const started = await launchChrome(profile, "about:blank", { headless: true });
    if ("error" in started) throw new Error(started.error);
    browser = started;
  }, 40_000);

  afterAll(async () => {
    // Chrome writes its profile as it exits, so removing it any sooner races.
    if (browser && browser.process.exitCode === null) {
      const exited = new Promise((r) => browser.process.once("exit", r));
      browser.process.kill();
      await exited;
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  });

  const target = () => ({ port: browser.port });

  it("stops a busy loop at the deadline, and the page answers again", async () => {
    const r = await evaluate(target(), "(() => { while (true) {} })()", { timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not finish within 1s and was stopped");
    expect((await evaluate(target(), "1 + 1")).value).toBe(2);
  }, 20_000);

  it("stops waiting for a promise that never settles, and the page answers again", async () => {
    // Nothing is running to stop, so the honest report is that btrix stopped
    // waiting -- whatever the expression scheduled may still happen.
    const r = await evaluate(target(), "new Promise(() => {})", { timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not finish within 1s; btrix stopped waiting");
    expect((await evaluate(target(), "1 + 1")).value).toBe(2);
  }, 20_000);

  it("waits for a promise that settles inside the deadline", async () => {
    const r = await evaluate(target(), "new Promise((r) => setTimeout(() => r('late'), 300))", { timeoutMs: 2_000 });
    expect(r).toMatchObject({ ok: true, value: "late" });
  }, 20_000);
});
