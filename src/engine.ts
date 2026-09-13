/**
 * Container engine detection and live-container lookup.
 *
 * Knowing which containers are running is what turns the old plugin's guess —
 * "a `crawling` state whose config you don't recognize may be a leftover
 * container still running" — into a fact.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const IMAGE = "webrecorder/browsertrix-crawler";

let cached: string | undefined | null = null;

/** Prefer podman, fall back to docker, matching the plugin's runner. */
export async function engine(): Promise<string | undefined> {
  if (cached !== null) return cached ?? undefined;
  for (const candidate of ["podman", "docker"]) {
    try {
      await exec(candidate, ["--version"], { timeout: 5_000 });
      cached = candidate;
      return candidate;
    } catch {
      // try the next one
    }
  }
  cached = undefined;
  return undefined;
}

export interface RunningCrawl {
  id: string;
  /** Collection name, recovered from `--config /crawls/config/<name>.yaml`. */
  config?: string;
}

/**
 * Crawler containers currently running, with the config each one is crawling.
 *
 * `--no-trunc` matters: docker truncates the command column by default, which
 * would cut off the config path we parse the name out of.
 */
export async function runningCrawls(): Promise<RunningCrawl[]> {
  const bin = await engine();
  if (!bin) return [];
  try {
    const { stdout } = await exec(
      bin,
      ["ps", "--no-trunc", "--filter", `ancestor=${IMAGE}`, "--format", "{{.ID}}\t{{.Command}}"],
      { timeout: 10_000 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [id = "", command = ""] = line.split("\t");
        const m = /config\/([^/\s"']+?)\.ya?ml/.exec(command);
        return { id, config: m?.[1] };
      })
      .filter((c) => c.id);
  } catch {
    return [];
  }
}

export async function isCrawlRunning(name: string): Promise<boolean> {
  return (await runningCrawls()).some((c) => c.config === name);
}

/** Stop the container crawling `name`. Used to wire a tool's AbortSignal. */
export async function killCrawl(name: string): Promise<boolean> {
  const bin = await engine();
  if (!bin) return false;
  const targets = (await runningCrawls()).filter((c) => c.config === name);
  let killed = false;
  for (const t of targets) {
    try {
      await exec(bin, ["kill", t.id], { timeout: 15_000 });
      killed = true;
    } catch {
      // Already gone, or not ours to kill.
    }
  }
  return killed;
}
