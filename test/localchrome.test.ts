/**
 * Finding and launching a local Chrome. Launching one is left to a manual
 * check — it opens a window — so what is tested is discovery, the port
 * handshake, and the failure messages.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findChrome, launchChrome, readDevToolsPort } from "../src/localchrome.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-chrome-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("findChrome", () => {
  it("honours an explicit override, and rejects one that does not exist", async () => {
    const fake = path.join(dir, "my-chrome");
    fs.writeFileSync(fake, "#!/bin/sh\n");
    expect(await findChrome({ BTRIX_CHROME: fake })).toBe(fake);
    // Silently falling back would be worse than saying it is missing.
    expect(await findChrome({ BTRIX_CHROME: path.join(dir, "nope") })).toBeUndefined();
  });

  it("finds a real browser on this machine", async () => {
    const found = await findChrome({});
    // The test host has Chrome; elsewhere this is allowed to be absent.
    if (found) expect(fs.existsSync(found)).toBe(true);
  });
});

describe("readDevToolsPort", () => {
  it("reads the port Chrome chose", () => {
    // Chrome writes the port on the first line and a ws path on the second.
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "51423\n/devtools/browser/abc\n");
    expect(readDevToolsPort(dir)).toBe(51423);
  });

  it("returns nothing for a missing or unusable file", () => {
    expect(readDevToolsPort(path.join(dir, "elsewhere"))).toBeUndefined();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "not a port\n");
    expect(readDevToolsPort(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "0\n");
    expect(readDevToolsPort(dir)).toBeUndefined();
  });
});

/**
 * launchChrome is never called here without an override pointing nowhere: with
 * a real browser on PATH it would open a window, and the cleanup would race
 * with Chrome still writing its profile. The launching path is a manual check.
 */
describe("launchChrome", () => {
  const withoutChrome = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = process.env.BTRIX_CHROME;
    process.env.BTRIX_CHROME = path.join(dir, "definitely-not-here");
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.BTRIX_CHROME;
      else process.env.BTRIX_CHROME = saved;
    }
  };

  it("says what to do when there is no browser to launch", async () => {
    const result = await withoutChrome(() =>
      launchChrome(path.join(dir, "profile"), "https://example.org/", { timeoutMs: 1 }),
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("BTRIX_CHROME");
      // The container browser is still there, and the message should say so.
      expect(result.error).toContain("crawler's own browser");
    }
  });

  it("does not create a profile directory it never used", async () => {
    const profile = path.join(dir, "unused-profile");
    await withoutChrome(() => launchChrome(profile, "https://example.org/", { timeoutMs: 1 }));
    expect(fs.existsSync(profile)).toBe(false);
  });
});
