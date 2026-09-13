/**
 * Pure parser for Browsertrix Crawler's JSON log lines.
 *
 * No filesystem access: `foldLine` takes one raw line and folds it into an
 * accumulator, so the whole thing is testable against captured fixtures.
 *
 * Line shapes (verified against real crawls, browsertrix-crawler 1.14.x):
 *   {"timestamp","logLevel","context":"crawlStatus","message":"Crawl statistics",
 *    "details":{crawled,total,pending,failed,excluded,limit,pendingPages:[json-string,…]}}
 *   {…,"context":"pageStatus","message":"Page Finished","details":{loadState,page,workerid}}
 *   {…,"context":"general","message":"Crawling done"}
 *   {…,"context":"general","message":"Generating WACZ"}
 */

/** Where the crawler is in its lifecycle, read from its own log messages. */
export type CrawlPhase =
  | "starting" // process up, no statistics yet
  | "crawling" // fetching pages
  | "post-crawl" // "Crawling done" seen; merging CDX etc.
  | "generating-wacz" // "Generating WACZ" seen; still writing
  | "done"; // WACZ on disk

export interface PendingPage {
  url: string;
  started?: string;
}

/** Everything the log alone can tell us. Sizes and disk come from elsewhere. */
export interface LogFacts {
  crawled: number;
  total: number;
  failed: number;
  excluded: number;
  pending: number;
  pendingPages: PendingPage[];
  /** Pages that logged "Page Finished" — a directly observed count. */
  pagesFinished: number;
  /** Crawler's own timestamp on the most recent "Page Finished". */
  lastPageFinishedAt?: string;
  /** `pageLimit` from the config, as the crawler reports it. */
  pageLimit?: number;
  /** The crawl stopped because it hit `pageLimit`, so it is not complete. */
  limitHit: boolean;
  /** Counted from the `message` field only — see note in `foldLine`. */
  rateLimited: number;
  warnings: number;
  errors: number;
  /** Most recent warn/error message, for the widget's second line. */
  lastProblem?: string;
  phase: CrawlPhase;
  /** Crawler version from the banner line, when seen. */
  version?: string;
  /** Crawler's own timestamp on the last line parsed. */
  lastTimestamp?: string;
}

export function emptyFacts(): LogFacts {
  return {
    crawled: 0,
    total: 0,
    failed: 0,
    excluded: 0,
    pending: 0,
    pendingPages: [],
    pagesFinished: 0,
    limitHit: false,
    rateLimited: 0,
    warnings: 0,
    errors: 0,
    phase: "starting",
  };
}

interface LogLine {
  timestamp?: string;
  logLevel?: string;
  context?: string;
  message?: string;
  details?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * `pendingPages` entries are JSON *strings* nested inside the details object,
 * so they need a second parse.
 */
function parsePendingPages(raw: unknown): PendingPage[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    try {
      const p = JSON.parse(entry) as { url?: unknown; started?: unknown };
      if (typeof p.url === "string") {
        out.push({ url: p.url, started: typeof p.started === "string" ? p.started : undefined });
      }
    } catch {
      // A pending-page blob we can't read is not worth failing a status call over.
    }
  }
  return out;
}

/**
 * Fold one raw log line into `acc`. Unparseable lines are ignored: logs are
 * read while the crawler is writing them, so a torn final line is normal.
 */
export function foldLine(acc: LogFacts, raw: string): LogFacts {
  const line = raw.trim();
  if (!line) return acc;

  let d: LogLine;
  try {
    d = JSON.parse(line) as LogLine;
  } catch {
    return acc;
  }

  if (typeof d.timestamp === "string") acc.lastTimestamp = d.timestamp;

  const message = typeof d.message === "string" ? d.message : "";
  const details = (d.details ?? {}) as Record<string, unknown>;

  // Count rate limiting from the `message` field only. progress.sh matched
  // "rate limited" against the whole raw line, which also matches any URL or
  // timestamp containing that text.
  if (/rate limit/i.test(message)) acc.rateLimited++;

  // The crawler warns about redis while it waits for its own state store to
  // come up, every single run. Reporting that as the crawl's "last problem"
  // puts a fault in front of the user where there is none. Suppressed only
  // before the crawl starts: redis trouble mid-crawl is real.
  const benignStartup =
    acc.phase === "starting" && (d.context === "redis" || d.context === "state" || /waiting for redis/i.test(message));

  if (!benignStartup) {
    if (d.logLevel === "warn") {
      acc.warnings++;
      acc.lastProblem = message;
    } else if (d.logLevel === "error" || d.logLevel === "fatal") {
      acc.errors++;
      acc.lastProblem = message;
    }
  }

  switch (d.context) {
    case "crawlStatus": {
      acc.crawled = num(details.crawled) ?? acc.crawled;
      acc.total = num(details.total) ?? acc.total;
      acc.failed = num(details.failed) ?? acc.failed;
      acc.excluded = num(details.excluded) ?? acc.excluded;
      acc.pending = num(details.pending) ?? acc.pending;
      acc.pendingPages = parsePendingPages(details.pendingPages);
      const limit = details.limit as { max?: unknown; hit?: unknown } | undefined;
      if (limit) {
        const max = num(limit.max);
        // max: 0 means unlimited.
        acc.pageLimit = max && max > 0 ? max : undefined;
        if (limit.hit === true) acc.limitHit = true;
      }
      if (acc.phase === "starting") acc.phase = "crawling";
      break;
    }
    case "pageStatus": {
      if (message === "Page Finished") {
        acc.pagesFinished++;
        if (typeof d.timestamp === "string") acc.lastPageFinishedAt = d.timestamp;
      }
      break;
    }
    case "general": {
      if (message.startsWith("Browsertrix-Crawler ")) {
        acc.version = message.slice("Browsertrix-Crawler ".length).split(" ")[0];
      } else if (message === "Crawling done") {
        acc.phase = "post-crawl";
      } else if (message === "Generating WACZ") {
        acc.phase = "generating-wacz";
      }
      break;
    }
  }

  return acc;
}

/** Convenience for tests and one-shot reads. */
export function foldLines(lines: Iterable<string>, acc: LogFacts = emptyFacts()): LogFacts {
  for (const line of lines) foldLine(acc, line);
  return acc;
}
