/**
 * The scratch browser's guards. Opening a real browser needs a container, so
 * the happy path is a manual end-to-end check; what is tested here is that the
 * tools refuse sensibly and never claim to touch the user's own browser.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScratchBrowser } from "../src/browser.ts";
import { CrawlMonitor } from "../src/monitor.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";
import { createTools } from "../src/tools.ts";

let dir: string;
let store: Store;
let monitor: CrawlMonitor;
let browser: ScratchBrowser;
let tools: ReturnType<typeof createTools>;

const tool = (name: string) => tools.find((t) => t.name === name)!;
const run = (name: string, params: any) => tool(name).execute("id", params, undefined, undefined, {} as any);
const said = (r: any) => r.content.map((c: any) => c.text).join(" ");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-browser-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
  monitor = new CrawlMonitor();
  browser = new ScratchBrowser(() => store.chromeProfileDir);
  tools = createTools(monitor, () => store, () => undefined, undefined, browser);
});
afterEach(() => {
  monitor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ScratchBrowser", () => {
  it("names its container per process, so two sessions do not collide", () => {
    expect(browser.container).toBe(`btrix-browser-${process.pid}`);
    expect(browser.isRunning()).toBe(false);
    expect(browser.vncUrl()).toBe("http://localhost:6080/");
  });

  it("stopping when nothing runs is a no-op, not an error", async () => {
    await expect(browser.stop()).resolves.toBeUndefined();
  });
});

describe("btrix_browser guards", () => {
  it("reports honestly when nothing is open", async () => {
    expect(said(await run("btrix_browser", {}))).toContain("No scratch browser is running");
    expect(said(await run("btrix_browser", { stop: true }))).toContain("No scratch browser is running");
  });

  it("refuses a non-url and a non-http scheme without starting anything", async () => {
    expect(said(await run("btrix_browser", { url: "not a url" }))).toContain("is not a url");
    expect(said(await run("btrix_browser", { url: "file:///etc/passwd" }))).toContain("Only http and https");
    expect(browser.isRunning()).toBe(false);
  });
});

describe("btrix_eval guards", () => {
  it("says to open a page first rather than failing obscurely", async () => {
    expect(said(await run("btrix_eval", { js: "1+1" }))).toContain("Open a page with btrix_browser first");
  });

  it("reports a thrown expression as a result, not as a tool failure", async () => {
    // A behaviour author gets selectors wrong constantly; that is information,
    // not an error to bail on.
    const fake = {
      isRunning: () => true,
      eval: vi.fn().mockResolvedValue({
        ok: false,
        error: "TypeError: Cannot read properties of null (reading 'click')",
        console: ["[behaviour] trying .load-more"],
        url: "https://example.org/",
      }),
    } as unknown as ScratchBrowser;
    const withFake = createTools(monitor, () => store, () => undefined, undefined, fake);
    const result: any = await withFake
      .find((t) => t.name === "btrix_eval")!
      .execute("id", { js: "document.querySelector('.load-more').click()" }, undefined, undefined, {} as any);

    const out = said(result);
    expect(out).toContain("threw: TypeError");
    expect(out).toContain("[behaviour] trying .load-more");
    expect(result.details.ok).toBe(false);
  });

  it("returns the value and the console output together", async () => {
    const fake = {
      isRunning: () => true,
      eval: vi.fn().mockResolvedValue({ ok: true, value: 42, console: ["[behaviour] found 42"], url: "https://x.test/" }),
    } as unknown as ScratchBrowser;
    const withFake = createTools(monitor, () => store, () => undefined, undefined, fake);
    const out = said(
      await withFake.find((t) => t.name === "btrix_eval")!.execute("id", { js: "42" }, undefined, undefined, {} as any),
    );
    expect(out).toContain("=> 42");
    expect(out).toContain("[behaviour] found 42");
    expect(out).toContain("page: https://x.test/");
  });
});

describe("tool descriptions", () => {
  it("say plainly that this is never the user's own browsing session", () => {
    // The model must not think it is driving the browser the user lives in.
    for (const name of ["btrix_browser", "btrix_eval"]) {
      const d = tool(name).description.replace(/\s+/g, " ");
      expect(d).toMatch(/never the user's own|not the user's own/);
    }
  });

  it("say which browser is the default, and that the other exists", () => {
    const d = tool("btrix_browser").description.replace(/\s+/g, " ");
    expect(d).toContain("Defaults to a local Chrome");
    expect(d).toContain("crawler");
    // A fresh profile either way, which is the security-relevant part.
    expect(d).toContain("fresh profile");
  });
});

describe("browser kinds", () => {
  it("refuses a browser it does not have", async () => {
    expect(said(await run("btrix_browser", { url: "https://example.org/", use: "firefox" }))).toContain(
      'is not a browser',
    );
    expect(browser.isRunning()).toBe(false);
  });

  it("reports nothing running before anything starts", () => {
    expect(browser.runningKind()).toBeUndefined();
  });
});
