/**
 * Rendering. Two consumers, one source of truth.
 *
 * Discipline: facts here, diagnosis in the model. The widget says
 * "no new page 4m", never "stalled" — stall detection is a heuristic with a
 * timeout, and moving it from prose into TypeScript must not launder a guess
 * into certainty. Anything uncertain is carried by colour, not by adjective.
 */

import { humanBytes, humanDuration } from "./sizes.ts";
import type { CrawlStats } from "./stats.ts";

/**
 * Structural stand-in for pi's Theme, so this module (and its tests) do not
 * need the harness. pi's Theme satisfies it.
 */
export interface ThemeLike {
  fg(color: string, text: string): string;
}

/** Identity theme, for tests and non-TUI callers. */
export const plainTheme: ThemeLike = { fg: (_c, t) => t };

const STATE_LABEL: Record<CrawlStats["state"], string> = {
  "no-stats": "starting",
  crawling: "crawling",
  "post-crawl": "merging",
  "generating-wacz": "writing wacz",
  done: "done",
  stopped: "stopped",
};

const STATE_COLOR: Record<CrawlStats["state"], string> = {
  "no-stats": "dim",
  crawling: "accent",
  "post-crawl": "accent",
  "generating-wacz": "accent",
  done: "success",
  stopped: "warning",
};

/** Rates only mean something while something is actually running. */
function isLive(s: CrawlStats): boolean {
  return s.state === "crawling" || s.state === "post-crawl" || s.state === "generating-wacz";
}

function percent(s: CrawlStats): string {
  if (!s.total) return "";
  return `${Math.round((s.crawled / s.total) * 100)}%`;
}

/**
 * Two lines above the editor, repainted on each poll tick. No model turn is
 * involved, which is the entire point of the exercise.
 */
export function renderWidget(s: CrawlStats, theme: ThemeLike = plainTheme): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const sep = dim(" · ");

  const head: string[] = [
    theme.fg("accent", "btrix"),
    theme.fg("border", "│"),
    theme.fg(STATE_COLOR[s.state], STATE_LABEL[s.state]),
    theme.fg("text", s.name),
  ];

  const progress: string[] = [];
  if (s.total) {
    progress.push(theme.fg("text", `${s.crawled}/${s.total}`));
    const pct = percent(s);
    // Say so when `total` is still growing: percent can fall while pages
    // complete, which otherwise reads as the crawl going backwards.
    progress.push(dim(s.discovering ? `${pct} still discovering` : pct));
  } else if (s.crawled) {
    progress.push(theme.fg("text", `${s.crawled} pages`));
  }
  if (s.pagesPerMin !== undefined && s.state === "crawling") {
    progress.push(dim(`${s.pagesPerMin.toFixed(1)} pg/min`));
  }
  if (s.bytesPerMin !== undefined && s.bytesPerMin > 0 && isLive(s)) {
    progress.push(dim(`${humanBytes(s.bytesPerMin)}/min`));
  }

  const detail: string[] = [];
  const stored = s.bytes.wacz ?? s.bytes.archive;
  if (stored !== undefined) detail.push(dim(`${s.bytes.wacz ? "wacz" : "archive"} ${humanBytes(stored)}`));
  // The browser profile is not part of the WACZ, so it is reported apart.
  if (s.bytes.profile !== undefined) detail.push(dim(`profile ${humanBytes(s.bytes.profile)}`));
  if (s.free !== undefined) {
    const tight = isLive(s) && s.diskFullIn !== undefined && s.diskFullIn < 60 * 60_000;
    const eta =
      isLive(s) && s.diskFullIn !== undefined && s.diskFullIn < 24 * 3600_000
        ? ` (full in ~${humanDuration(s.diskFullIn)})`
        : "";
    detail.push(theme.fg(tight ? "error" : "dim", `${humanBytes(s.free)} free${eta}`));
  }
  if (s.limitHit) detail.push(theme.fg("warning", `stopped at pageLimit ${s.pageLimit ?? "?"}`));
  if (s.rateLimited) detail.push(theme.fg("warning", `rate-limited ${s.rateLimited}`));
  if (s.failed) detail.push(theme.fg("warning", `failed ${s.failed}`));
  if (s.errors) detail.push(theme.fg("error", `errors ${s.errors}`));
  // An observation with a number attached, not the word "stalled".
  if (s.state === "crawling" && s.sinceLastPage !== undefined && s.sinceLastPage > 120_000) {
    detail.push(theme.fg("warning", `no new page ${humanDuration(s.sinceLastPage)}`));
  }
  if (s.state === "crawling") detail.push(dim("screencast :9037"));

  const lines = [head.join(" ") + (progress.length ? sep + progress.join(sep) : "")];
  if (detail.length) lines.push("      " + detail.join(sep));

  const url = s.pending[0]?.url;
  if (url && s.state === "crawling") {
    lines.push("      " + dim(`fetching ${url.length > 88 ? url.slice(0, 87) + "…" : url}`));
  }
  return lines;
}

/**
 * Compact serialization for the model. Deliberately smaller than the old
 * progress.sh output: the widget already carries the ambient numbers, so this
 * only needs to support a question or a diagnosis.
 */
export function renderForModel(s: CrawlStats): string {
  const parts: string[] = [`${s.name}: ${STATE_LABEL[s.state]}`];
  if (s.total) parts.push(`${s.crawled}/${s.total} pages${s.discovering ? " (total still growing)" : ""}`);
  else if (s.crawled) parts.push(`${s.crawled} pages`);
  if (s.pagesPerMin !== undefined && isLive(s)) parts.push(`${s.pagesPerMin.toFixed(1)} pages/min`);

  const size = s.bytes.wacz ?? s.bytes.archive;
  if (size !== undefined) parts.push(`${s.bytes.wacz ? "wacz" : "archive"} ${humanBytes(size)}`);
  if (s.bytes.profile !== undefined) parts.push(`profile ${humanBytes(s.bytes.profile)} (not in the wacz)`);
  if (s.free !== undefined) parts.push(`${humanBytes(s.free)} free`);
  if (isLive(s) && s.diskFullIn !== undefined && s.diskFullIn < 6 * 3600_000) {
    parts.push(`disk full in ~${humanDuration(s.diskFullIn)} at current rate`);
  }
  if (s.limitHit) parts.push(`stopped at pageLimit ${s.pageLimit ?? "?"}, so the crawl is truncated, not complete`);
  if (s.failed) parts.push(`failed ${s.failed}`);
  if (s.rateLimited) parts.push(`rate-limited ${s.rateLimited}`);
  if (s.errors) parts.push(`errors ${s.errors}`);
  if (s.sinceLastPage !== undefined && s.state === "crawling") {
    parts.push(`last page completed ${humanDuration(s.sinceLastPage)} ago`);
  }
  if (s.state === "crawling" && s.pending[0]) parts.push(`fetching ${s.pending[0].url}`);
  if (s.waczPath) parts.push(`wacz at ${s.waczPath}`);
  if (s.state === "stopped") parts.push("no container running and no wacz — the crawl ended early");
  if (s.lastProblem) parts.push(`last warning/error: ${s.lastProblem}`);
  if (s.windowMs < 30_000 && s.pagesPerMin !== undefined) parts.push("(rates based on <30s of history)");
  return parts.join(" · ");
}
