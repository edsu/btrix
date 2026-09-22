/**
 * Owns the tailers and the poll loop, and decides when a crawl has finished.
 *
 * Knows nothing about pi, and nothing about where the store is: callers hand it
 * a target, because each crawl attempt reads from its own run directory.
 */

import { type RunningCrawl, runningCrawls } from "./engine.ts";
import { CrawlTailer, type CrawlStats } from "./stats.ts";

/** A crawl to watch: which collection, in which directory. */
export interface WatchTarget {
  /** Config name, as the user says it and as the container reports it. */
  config: string;
  /** Collection name from the config, which need not match. */
  collection: string;
  /** Directory holding `collections/` — a run dir, or a legacy working dir. */
  root: string;
}

export interface MonitorOptions {
  intervalMs?: number;
  onTick?: (stats: CrawlStats, target: WatchTarget) => void;
  /** Called once when a crawl we saw running reaches a terminal state. */
  onComplete?: (stats: CrawlStats, target: WatchTarget) => void | Promise<void>;
}

interface Entry {
  target: WatchTarget;
  tailer: CrawlTailer;
  /** Whether we have observed this crawl alive. Guards against announcing
   *  "finished" for something that was already done when we started up. */
  sawLive: boolean;
  /** Consecutive ticks that positively observed no container. */
  absent: number;
  settled: boolean;
}

const TERMINAL = new Set<CrawlStats["state"]>(["done", "stopped"]);

/**
 * How many consecutive ticks must agree the container has gone before a crawl
 * is treated as finished.
 *
 * Settling is irreversible: `onComplete` renames the collection directory out
 * of the run directory. One `docker ps` that timed out under load, during
 * `post-crawl` and before the WACZ exists, would otherwise move the files out
 * from under a crawler that is still writing them.
 */
const ABSENT_TICKS = 3;

export class CrawlMonitor {
  private readonly intervalMs: number;
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private opts: MonitorOptions;

  constructor(opts: MonitorOptions = {}) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? 1_000;
  }

  /**
   * Begin (or resume) tailing. Idempotent per config name.
   *
   * Callers that merely want a reading should use `stats()`: watching a crawl
   * that has already finished puts it back on screen as though it were live.
   */
  watch(target: WatchTarget): void {
    const existing = this.entries.get(target.config);
    if (existing && existing.target.root === target.root) {
      existing.settled = false;
      existing.absent = 0;
    } else {
      this.entries.set(target.config, {
        target,
        tailer: new CrawlTailer(target.collection, target.root, target.config),
        sawLive: false,
        absent: 0,
        settled: false,
      });
    }
    this.start();
  }

  unwatch(config: string): void {
    this.entries.delete(config);
    if (this.entries.size === 0) this.stop();
  }

  watched(): WatchTarget[] {
    return [...this.entries.values()].map((e) => e.target);
  }

  /** One-shot reading, without starting the poll loop. */
  async stats(target: WatchTarget): Promise<CrawlStats> {
    const existing = this.entries.get(target.config);
    if (existing && existing.target.root === target.root) return existing.tailer.read();
    return new CrawlTailer(target.collection, target.root, target.config).read();
  }

  /**
   * Adopt crawler containers already running, using a caller-supplied
   * resolver since only the caller knows where the store is.
   *
   * `crawls` lets a caller that has already asked the engine hand the answer
   * over instead of provoking a second `ps`. Startup does: it needs the same
   * list to decide which finished runs the promotion sweep may touch, and on
   * a cold or loaded Docker a single `ps` is seconds rather than milliseconds.
   */
  async adoptRunning(
    resolve: (config: string) => WatchTarget | undefined,
    crawls?: readonly RunningCrawl[],
  ): Promise<WatchTarget[]> {
    const adopted: WatchTarget[] = [];
    for (const { config } of crawls ?? (await runningCrawls())) {
      if (!config) continue;
      const target = resolve(config);
      if (!target) continue;
      this.watch(target);
      adopted.push(target);
    }
    return adopted;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Do not hold the process open on our account.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
    this.entries.clear();
  }

  /** Poll every watched crawl once. Overlapping ticks are skipped, since a
   *  `du` over a large archive can outlast the interval. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [name, e] of [...this.entries]) {
        if (e.settled) continue;
        let stats: CrawlStats;
        try {
          stats = await e.tailer.read();
        } catch {
          continue;
        }
        if (!TERMINAL.has(stats.state) || stats.containerRunning) e.sawLive = true;
        this.opts.onTick?.(stats, e.target);

        // Only an observation we actually made counts towards settling. A tick
        // where the engine could not be asked says nothing about the crawl.
        if (stats.containerRunning || !stats.containerKnown) e.absent = 0;
        else e.absent += 1;

        if (e.sawLive && TERMINAL.has(stats.state) && e.absent >= ABSENT_TICKS) {
          e.settled = true;
          await this.opts.onComplete?.(stats, e.target);
          // Stop polling it. A finished crawl left in the loop keeps getting
          // repainted, which is how a completed crawl ended up sitting in the
          // widget looking active.
          this.entries.delete(name);
          if (this.entries.size === 0) this.stop();
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
