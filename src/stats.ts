/**
 * Incremental log tailer and the derived numbers that come out of it.
 *
 * The old plugin's progress.sh printed a *snapshot*: it re-read every log file
 * from the top on each call and had no history, so the rules that mattered most
 * ("flat page count but growing bytes means an asset is downloading, not a
 * stall") were left to the model to work out by diffing against a reading from
 * two minutes ago. Holding a byte offset plus a small ring buffer makes those
 * derivatives computable, and cheap enough to poll once a second.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isCrawlRunning } from "./engine.ts";
import { type CrawlPhase, emptyFacts, foldLine, type LogFacts, type PendingPage } from "./log.ts";
import { dirSize, fileSize, freeSpace } from "./sizes.ts";

/** One observation, kept in the ring buffer to derive rates from. */
export interface CrawlSample {
  t: number;
  crawled: number;
  total: number;
  bytes: number;
}

export type CrawlState =
  | "no-stats" // nothing in the logs yet
  | "crawling"
  | "post-crawl" // finished fetching, merging CDX
  | "generating-wacz"
  | "done" // WACZ on disk
  | "stopped"; // no container, no WACZ — died or was killed

export interface CrawlStats {
  /** Collection name — the directory the crawler writes into. */
  name: string;
  /** Config that produced it. Shown when it differs from the collection. */
  config?: string;
  state: CrawlState;
  phase: CrawlPhase;
  containerRunning: boolean;

  crawled: number;
  total: number;
  failed: number;
  excluded: number;
  rateLimited: number;
  pageLimit?: number;
  limitHit: boolean;
  warnings: number;
  errors: number;
  lastProblem?: string;
  pending: PendingPage[];
  version?: string;

  bytes: { archive?: number; profile?: number; wacz?: number };
  free?: number;
  waczPath?: string;

  // Derivatives — not expressible in a single snapshot.
  pagesPerMin?: number;
  bytesPerMin?: number;
  /** ms since a page last completed, from the crawler's own timestamps. */
  sinceLastPage?: number;
  /** `total` grew inside the sample window, so percent can still fall. */
  discovering: boolean;
  /** ms until free space runs out at the current write rate. */
  diskFullIn?: number;
  /** ms of history the rates are based on; small windows are unreliable. */
  windowMs: number;
}

const MAX_SAMPLES = 60;
const SIZE_REFRESH_MS = 5_000;

export class CrawlTailer {
  readonly name: string;
  readonly config?: string;
  private readonly dir: string;
  private readonly facts: LogFacts = emptyFacts();
  private readonly offsets = new Map<string, number>();
  private readonly remainders = new Map<string, string>();
  private readonly samples: CrawlSample[] = [];
  private sizes: { archive?: number; profile?: number; wacz?: number; free?: number; at: number } = { at: 0 };

  /**
   * `root` is whatever directory holds `collections/` — a run directory under
   * the store, or a legacy/hand-run working directory.
   */
  constructor(name: string, root: string = process.cwd(), config?: string) {
    this.name = name;
    this.config = config;
    this.dir = path.join(root, "collections", name);
  }

  private logFiles(): string[] {
    try {
      return fs
        .readdirSync(path.join(this.dir, "logs"))
        .filter((f) => f.endsWith(".log"))
        .sort()
        .map((f) => path.join(this.dir, "logs", f));
    } catch {
      return [];
    }
  }

  /** Read only the bytes appended since last time, per file. */
  private async ingest(): Promise<void> {
    for (const file of this.logFiles()) {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      const from = this.offsets.get(file) ?? 0;
      // Truncated or rotated underneath us: start over on this file.
      if (size < from) {
        this.offsets.set(file, 0);
        this.remainders.set(file, "");
        continue;
      }
      if (size === from) continue;

      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(file, "r");
        const length = size - from;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, from);
        const text = (this.remainders.get(file) ?? "") + buf.toString("utf8");
        const lines = text.split("\n");
        // The crawler may be mid-write; hold the tail until it completes.
        this.remainders.set(file, lines.pop() ?? "");
        for (const line of lines) foldLine(this.facts, line);
        this.offsets.set(file, size);
      } catch {
        // Unreadable this tick; try again next tick.
      } finally {
        await handle?.close();
      }
    }
  }

  /** The directory this tailer is reading, for callers that need to move it. */
  get collectionDir(): string {
    return this.dir;
  }

  private async refreshSizes(now: number): Promise<void> {
    if (now - this.sizes.at < SIZE_REFRESH_MS) return;
    const wacz = this.waczPath();
    const [archive, profile, free] = await Promise.all([
      dirSize(path.join(this.dir, "archive")),
      dirSize(path.join(this.dir, "profile")),
      freeSpace(this.dir_or_cwd()),
    ]);
    this.sizes = { archive, profile, wacz: wacz ? fileSize(wacz) : undefined, free, at: now };
  }

  private dir_or_cwd(): string {
    return fs.existsSync(this.dir) ? this.dir : ".";
  }

  private waczPath(): string | undefined {
    try {
      const hit = fs.readdirSync(this.dir).find((f) => f.endsWith(".wacz"));
      return hit ? path.join(this.dir, hit) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Take a reading. Safe to call at 1 Hz. */
  async read(now: number = Date.now()): Promise<CrawlStats> {
    await this.ingest();
    await this.refreshSizes(now);

    const f = this.facts;
    const bytes = { archive: this.sizes.archive, profile: this.sizes.profile, wacz: this.sizes.wacz };
    const written = (bytes.archive ?? 0) + (bytes.wacz ?? 0);

    this.samples.push({ t: now, crawled: f.crawled, total: f.total, bytes: written });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const windowMs = first && last ? last.t - first.t : 0;
    const perMin = (delta: number) => (windowMs > 5_000 ? (delta / windowMs) * 60_000 : undefined);

    const pagesPerMin = first && last ? perMin(last.crawled - first.crawled) : undefined;
    const bytesPerMin = first && last ? perMin(last.bytes - first.bytes) : undefined;
    const discovering = !!first && !!last && last.total > first.total;

    const sinceLastPage = f.lastPageFinishedAt ? now - Date.parse(f.lastPageFinishedAt) : undefined;

    const free = this.sizes.free;
    const diskFullIn =
      free !== undefined && bytesPerMin !== undefined && bytesPerMin > 0
        ? (free / bytesPerMin) * 60_000
        : undefined;

    const waczPath = this.waczPath();
    const containerRunning = await isCrawlRunning(this.name);

    return {
      name: this.name,
      config: this.config,
      state: deriveState({ facts: f, wacz: !!waczPath, containerRunning }),
      phase: f.phase,
      containerRunning,
      crawled: f.crawled,
      total: f.total,
      failed: f.failed,
      excluded: f.excluded,
      rateLimited: f.rateLimited,
      pageLimit: f.pageLimit,
      limitHit: f.limitHit,
      warnings: f.warnings,
      errors: f.errors,
      lastProblem: f.lastProblem,
      pending: f.pendingPages,
      version: f.version,
      bytes,
      free,
      waczPath,
      pagesPerMin,
      bytesPerMin,
      sinceLastPage: Number.isFinite(sinceLastPage) ? sinceLastPage : undefined,
      discovering,
      diskFullIn,
      windowMs,
    };
  }
}

/**
 * A WACZ on disk means done. Otherwise trust the log's phase while a container
 * is alive, and report "stopped" when nothing is running and no WACZ appeared —
 * a case the old plugin folded into `done*` alongside `generateWACZ: false`.
 */
export function deriveState(o: { facts: LogFacts; wacz: boolean; containerRunning: boolean }): CrawlState {
  if (o.wacz) return "done";
  if (o.facts.phase === "generating-wacz") return "generating-wacz";
  if (o.facts.phase === "post-crawl") return o.containerRunning ? "post-crawl" : "stopped";
  if (o.containerRunning) return o.facts.phase === "starting" ? "no-stats" : "crawling";
  return o.facts.crawled > 0 || o.facts.total > 0 ? "stopped" : "no-stats";
}

/** Collection directories present under ./collections. */
export function discoverCollections(cwd: string = process.cwd()): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, "collections"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
