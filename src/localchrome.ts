/**
 * Driving the Chrome already on this machine.
 *
 * Nicer than the container's browser for working out a behavior: a native
 * window instead of noVNC, real DevTools on F12, and no container to start.
 * The trade is that it is not the exact browser the crawler runs, which for
 * working out selectors rarely matters.
 *
 * It is always a *fresh* profile, never the one you browse with. Chrome refuses
 * `--remote-debugging-port` against the default profile directory, and rightly:
 * any local process could otherwise read the cookies of every site you are
 * signed in to.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const UNIX_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

/** The Chrome-family browser to drive, or undefined if none is installed. */
export async function findChrome(env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const override = env.BTRIX_CHROME?.trim();
  if (override) return fs.existsSync(override) ? override : undefined;

  if (process.platform === "darwin") {
    for (const candidate of MAC_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of UNIX_CANDIDATES) {
    try {
      const { stdout } = await exec("/usr/bin/which", [name], { encoding: "utf8", timeout: 5_000 });
      const found = stdout.trim().split("\n")[0]?.trim();
      if (found) return found;
    } catch {
      // Not on PATH; try the next.
    }
  }
  return undefined;
}

/**
 * Chrome writes the port it actually bound to here, which is how we can ask for
 * port 0 and avoid fighting over a fixed one.
 */
export function readDevToolsPort(profileDir: string): number | undefined {
  try {
    const first = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]?.trim();
    const port = Number.parseInt(first ?? "", 10);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

export interface LocalChrome {
  process: ChildProcess;
  port: number;
  profileDir: string;
  binary: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Launch a visible Chrome with a throwaway profile and DevTools enabled. */
export async function launchChrome(
  profileDir: string,
  url: string,
  opts: { timeoutMs?: number; headless?: boolean } = {},
): Promise<LocalChrome | { error: string }> {
  const binary = await findChrome();
  if (!binary) {
    return {
      error:
        "No Chrome, Chromium or Edge found. Install one, or set BTRIX_CHROME to its path. " +
        "The crawler's own browser is still available without it.",
    };
  }

  // A cookie jar, if a login happens while working out a behavior. 0700 so it
  // is not readable by other accounts for as long as it exists.
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  // A stale port file would be read as the live one.
  try {
    fs.rmSync(path.join(profileDir, "DevToolsActivePort"));
  } catch {
    // Not there, which is the normal case.
  }

  const args = [
    // Port 0 asks Chrome to choose, and it records the choice in the profile.
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Keep this instance out of the way of the browser you actually use.
    "--no-service-autorun",
    "--disable-features=Translate",
    ...(opts.headless ? ["--headless=new"] : []),
    url,
  ];

  const child = spawn(binary, args, { stdio: "ignore", detached: false });

  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { error: `Chrome exited immediately (code ${child.exitCode}). Is another instance using that profile?` };
    }
    const port = readDevToolsPort(profileDir);
    if (port) return { process: child, port, profileDir, binary };
    await sleep(250);
  }
  child.kill();
  return { error: "Chrome started but never reported a DevTools port." };
}
