/**
 * Login profiles. A profile is a credential, so the guards matter more than
 * the happy path — which needs a real browser and a real login, and so is left
 * to a person.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrawlMonitor } from "../src/monitor.ts";
import { CONTAINER_PROFILES, findProfile, listProfiles, safeProfileName } from "../src/profile.ts";
import { ensureStore, resolveStore, type Store } from "../src/store.ts";
import { createTools } from "../src/tools.ts";

let dir: string;
let store: Store;
let monitor: CrawlMonitor;
let tools: ReturnType<typeof createTools>;

const tool = () => tools.find((t) => t.name === "btrix_profile")!;
const run = (params: any) => tool().execute("id", params, undefined, undefined, {} as any);
const said = (r: any) => r.content.map((c: any) => c.text).join(" ");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-profile-"));
  store = ensureStore(resolveStore({ cwd: dir, env: {} }));
  monitor = new CrawlMonitor();
  tools = createTools(monitor, () => store);
});
afterEach(() => {
  monitor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("safeProfileName", () => {
  it("accepts ordinary names, including a host", () => {
    expect(safeProfileName("example.org")).toBe("example.org");
    expect(safeProfileName("stanford_news-2026")).toBe("stanford_news-2026");
    expect(safeProfileName("example.org.tar.gz")).toBe("example.org");
  });

  it("rejects anything that would escape the profiles directory", () => {
    // The name becomes a filename, and a mount path inside the container.
    expect(safeProfileName("../../etc/passwd")).toBeUndefined();
    expect(safeProfileName("a/b")).toBeUndefined();
    expect(safeProfileName("")).toBeUndefined();
    expect(safeProfileName(".hidden")).toBeUndefined();
    expect(safeProfileName("has space")).toBeUndefined();
    expect(safeProfileName("x".repeat(100))).toBeUndefined();
  });
});

describe("listProfiles", () => {
  it("reports the config value to use, not just the path", () => {
    fs.writeFileSync(path.join(store.profilesDir, "example.org.tar.gz"), Buffer.alloc(2048));
    const [p] = listProfiles(store);
    expect(p).toMatchObject({ name: "example.org", bytes: 2048 });
    // What the crawler sees, which is what goes in the config.
    expect(p!.configValue).toBe(`${CONTAINER_PROFILES}/example.org.tar.gz`);
    expect(findProfile(store, "example.org")?.name).toBe("example.org");
    expect(findProfile(store, "nope")).toBeUndefined();
  });

  it("ignores non-profile files, including the capture log", () => {
    fs.writeFileSync(path.join(store.profilesDir, ".example.org.log"), "noise");
    fs.writeFileSync(path.join(store.profilesDir, "notes.txt"), "x");
    expect(listProfiles(store)).toEqual([]);
  });
});

describe("btrix_profile guards", () => {
  it("lists nothing helpfully when there are no profiles", async () => {
    expect(said(await run({}))).toContain("No login profiles");
  });

  it("lists existing profiles with their config line and an expiry warning", async () => {
    fs.writeFileSync(path.join(store.profilesDir, "example.org.tar.gz"), Buffer.alloc(4096));
    const out = said(await run({}));
    expect(out).toContain("example.org");
    expect(out).toContain(`profile: ${CONTAINER_PROFILES}/example.org.tar.gz`);
    // An old profile that is silently logged out is the usual failure.
    expect(out).toContain("Session cookies expire");
  });

  it("refuses a url carrying credentials", async () => {
    // These would land in the container command line and in `docker ps`.
    const out = said(await run({ url: "https://user:hunter2@example.org/login" }));
    expect(out).toContain("contains credentials");
    expect(out).not.toContain("hunter2");
    // Nothing was started.
    expect(fs.readdirSync(store.profilesDir)).toEqual([]);
  });

  it("refuses a non-url and a non-http scheme", async () => {
    expect(said(await run({ url: "not a url" }))).toContain("is not a url");
    expect(said(await run({ url: "file:///etc/passwd" }))).toContain("Only http and https");
  });

  it("refuses a profile name that would escape the directory", async () => {
    const out = said(await run({ url: "https://example.org/login", name: "../../evil" }));
    expect(out).toContain("not usable as a profile name");
    expect(fs.existsSync(path.join(store.profilesDir, "..", "..", "evil.tar.gz"))).toBe(false);
  });

  it("keeps the profiles directory private", () => {
    expect(fs.statSync(store.profilesDir).mode & 0o777).toBe(0o700);
  });
});
