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
  /** Config name, recovered from `--config /crawls/config/<name>.yaml`. */
  config?: string;
}

/**
 * Whether an image column names the crawler image, whatever tag it carries.
 *
 * `--filter ancestor=<name>` cannot answer this: an untagged ancestor matches
 * only `:latest`, so every container started with `BTRIX_CRAWLER_VERSION`
 * pinned — which all three scripts honour — looked like no container at all.
 * Podman also reports fully-qualified names, hence the suffix match rather
 * than equality.
 */
export function isCrawlerImage(image: string): boolean {
  const repo = image
    .trim()
    .replace(/@sha256:[0-9a-f]+$/i, "")
    .replace(/:[^:/]+$/, "");
  return repo === IMAGE || repo.endsWith(`/${IMAGE}`);
}

/**
 * Running containers built from the crawler image, with the command each was
 * started with.
 *
 * `ok` is false when the engine could not be asked at all. Callers about to
 * act irreversibly on "nothing is running" need to tell that apart from an
 * engine that answered and listed nothing.
 *
 * `--no-trunc` matters: docker truncates the command column by default, which
 * would cut off the config path we parse the name out of.
 */
async function crawlerContainers(): Promise<{ ok: boolean; rows: { id: string; command: string }[] }> {
  const bin = await engine();
  // No engine is a definite answer, not a failed one: with nothing to run
  // containers there are certainly none running.
  if (!bin) return { ok: true, rows: [] };
  try {
    const { stdout } = await exec(bin, ["ps", "--no-trunc", "--format", "{{.ID}}\t{{.Image}}\t{{.Command}}"], {
      timeout: 10_000,
    });
    const rows = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [id = "", image = "", command = ""] = line.split("\t");
        return { id, image, command };
      })
      .filter((r) => r.id && isCrawlerImage(r.image))
      .map(({ id, command }) => ({ id, command }));
    return { ok: true, rows };
  } catch {
    return { ok: false, rows: [] };
  }
}

/**
 * Crawler containers currently running, with the config each one is crawling,
 * and whether the engine could be asked at all.
 */
export async function crawlLookup(): Promise<{ ok: boolean; crawls: RunningCrawl[] }> {
  const { ok, rows } = await crawlerContainers();
  const crawls = rows
    // create-login-profile shares the image but is not a crawl.
    .filter((r) => !r.command.includes("create-login-profile"))
    .map((r) => ({ id: r.id, config: /config\/([^/\s"']+?)\.ya?ml/.exec(r.command)?.[1] }));
  return { ok, crawls };
}

/** As `crawlLookup`, for callers that treat "could not ask" as "none". */
export async function runningCrawls(): Promise<RunningCrawl[]> {
  return (await crawlLookup()).crawls;
}

/**
 * Profile-capture containers, which run `create-login-profile` rather than
 * `crawl`. Detected separately so a login session in progress is visible and a
 * second one cannot be started over the top of it.
 */
export async function runningProfileCaptures(): Promise<{ id: string; filename?: string }[]> {
  const { rows } = await crawlerContainers();
  return rows
    .filter((r) => r.command.includes("create-login-profile"))
    .map((r) => ({ id: r.id, filename: /profiles\/([^/\s"']+?)\.tar\.gz/.exec(r.command)?.[1] }));
}

/** Tri-state: `undefined` when the engine could not be asked. */
export async function isCrawlRunning(name: string): Promise<boolean | undefined> {
  const { ok, crawls } = await crawlLookup();
  if (!ok) return undefined;
  return crawls.some((c) => c.config === name);
}

/**
 * Stop containers by id, with `stop` rather than `kill`.
 *
 * `kill` sends SIGKILL, which would cut the crawler off mid-write and can leave
 * a WARC truncated. `stop` sends SIGTERM first and only escalates after the
 * grace period, giving it a chance to close its files, so a stopped crawl still
 * has usable output.
 */
export async function stopContainers(ids: string[], graceSeconds = 30): Promise<number> {
  const bin = await engine();
  if (!bin || !ids.length) return 0;
  let stopped = 0;
  for (const id of ids) {
    try {
      await exec(bin, ["stop", "-t", String(graceSeconds), id], { timeout: (graceSeconds + 15) * 1000 });
      stopped++;
    } catch {
      // Already gone, or not ours to stop.
    }
  }
  return stopped;
}

/** Kept for the abort-before-anything-is-written case. */
export async function killContainers(ids: string[]): Promise<number> {
  const bin = await engine();
  if (!bin || !ids.length) return 0;
  let killed = 0;
  for (const id of ids) {
    try {
      await exec(bin, ["kill", id], { timeout: 15_000 });
      killed++;
    } catch {
      // Already gone, or not ours to kill.
    }
  }
  return killed;
}

/**
 * Stop the crawl for `name`, letting the crawler close its files first so
 * whatever it captured stays readable.
 */
export async function stopCrawl(name: string, graceSeconds = 30): Promise<number> {
  const ids = (await runningCrawls()).filter((c) => c.config === name).map((c) => c.id);
  return stopContainers(ids, graceSeconds);
}

/** Engine availability, for telling the user at startup rather than mid-pull. */
export interface EngineStatus {
  /** The binary found, if any. */
  bin?: string;
  /** Whether it answers, i.e. the daemon is actually up. */
  usable: boolean;
  problem?: string;
}

export async function engineStatus(): Promise<EngineStatus> {
  const bin = await engine();
  if (!bin) {
    return {
      usable: false,
      problem:
        "No docker or podman found. Browsertrix Crawler runs in a container, so btrix cannot crawl without one. " +
        "Install Docker Desktop (https://docs.docker.com/get-docker/) or podman, then restart btrix.",
    };
  }
  try {
    // `info` needs the daemon, unlike `--version`, which only needs the client.
    await exec(bin, ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    return { bin, usable: true };
  } catch {
    return {
      bin,
      usable: false,
      problem: `${bin} is installed but not responding — its daemon is probably not running. Start ${
        bin === "docker" ? "Docker Desktop" : "the podman machine"
      } and try again.`,
    };
  }
}
