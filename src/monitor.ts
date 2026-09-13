/**
 * Owns the tailers and the poll loop, and decides when a crawl has finished.
 *
 * Kept separate from the extension wiring so it can be driven from a test or
 * any other front end: it knows nothing about pi.
 */

import { runningCrawls } from "./engine.ts";
import { CrawlTailer, type CrawlStats } from "./stats.ts";

export interface MonitorOptions {
  cwd?: string;
  intervalMs?: number;
  /** Called on every poll tick for every watched crawl. */
  onTick?: (stats: CrawlStats) => void;
  /** Called once, when a crawl we saw running reaches a terminal state. */
  onComplete?: (stats: CrawlStats) => void;
}

interface Entry {
  tailer: CrawlTailer;
  /** Whether we have actually observed this crawl alive. Guards against
   *  announcing "finished" for a collection that was already done when we
   *  started up. */
  sawLive: boolean;
  settled: boolean;
}

const TERMINAL = new Set<CrawlStats["state"]>(["done", "stopped"]);

export class CrawlMonitor {
  private readonly cwd: string;
  private readonly intervalMs: number;
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private opts: MonitorOptions;

  constructor(opts: MonitorOptions = {}) {
    this.opts = opts;
    this.cwd = opts.cwd ?? process.cwd();
    this.intervalMs = opts.intervalMs ?? 1_000;
  }

  private entry(name: string): Entry {
    let e = this.entries.get(name);
    if (!e) {
      e = { tailer: new CrawlTailer(name, this.cwd), sawLive: false, settled: false };
      this.entries.set(name, e);
    }
    return e;
  }

  /** Begin (or resume) tailing `name`. Idempotent. */
  watch(name: string): void {
    const e = this.entry(name);
    e.settled = false;
    this.start();
  }

  unwatch(name: string): void {
    this.entries.delete(name);
    if (this.entries.size === 0) this.stop();
  }

  watched(): string[] {
    return [...this.entries.keys()];
  }

  /** One-shot reading. Creates a tailer if needed but does not start polling. */
  async stats(name: string): Promise<CrawlStats> {
    return this.entry(name).tailer.read();
  }

  /** Adopt any crawler containers already running in this directory. */
  async adoptRunning(): Promise<string[]> {
    const names = (await runningCrawls()).map((c) => c.config).filter((n): n is string => !!n);
    for (const n of names) this.watch(n);
    return names;
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
        this.opts.onTick?.(stats);
        if (e.sawLive && TERMINAL.has(stats.state) && !stats.containerRunning) {
          e.settled = true;
          this.opts.onComplete?.(stats);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
