/**
 * Rendering. Two consumers, one source of truth.
 *
 * Discipline: facts here, diagnosis in the model. The widget says
 * "no new page 4m", never "stalled" — stall detection is a heuristic with a
 * timeout, and moving it from prose into TypeScript must not launder a guess
 * into certainty. Anything uncertain is carried by colour, not by adjective.
 */

import type { Inventory } from "./inventory.ts";
import { nextStep } from "./inventory.ts";
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

/**
 * A config named sulnews.yaml can declare `collection: stanford-news`. Showing
 * both when they diverge saves the user wondering why they asked about one name
 * and got another.
 */
function label(s: CrawlStats): string {
  return s.config && s.config !== s.name ? `${s.config} → ${s.name}` : s.name;
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
    theme.fg("text", label(s)),
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
  const parts: string[] = [`${label(s)}: ${STATE_LABEL[s.state]}`];
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

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/**
 * The inventory as a table for the human. No model involved: this is the
 * command whose entire old skill body was "interpret rather than restate".
 */
export function renderInventory(inv: Inventory, theme: ThemeLike = plainTheme): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  const rel = (p: string) => p.replace(`${inv.store.root}/`, "");

  lines.push(theme.fg("accent", "btrix") + dim(`  store ${inv.store.root}`));

  lines.push("");
  lines.push(theme.fg("toolTitle", "configs"));
  if (!inv.configs.length) lines.push(dim("  none yet — ask to create one"));
  for (const c of inv.configs) {
    const bits: string[] = [];
    if (c.collection !== c.name) bits.push(`collection ${c.collection}`);
    if (c.scopeType) bits.push(c.scopeType);
    if (c.pageLimit) bits.push(`limit ${c.pageLimit}`);
    if (c.behaviors.length) bits.push(`behavior ${c.behaviors.join(",")}`);
    // A config that generates no WACZ cannot be replayed, which is worth
    // knowing before the crawl rather than after.
    if (!c.generateWacz) bits.push("no wacz");
    const seed = (c.seed ?? "-").replace(/^https?:\/\//, "");
    lines.push(`  ${pad(c.name, 18)} ${dim(pad(seed.slice(0, 40), 40))} ${dim(bits.join(" · "))}`);
  }

  if (inv.runs.length) {
    lines.push("");
    lines.push(theme.fg("toolTitle", "runs"));
    for (const r of inv.runs) {
      const s = r.stats;
      const live = inv.running.includes(r.config);
      const colour = s.state === "done" ? "success" : s.state === "stopped" ? "warning" : "accent";
      const counts = s.total ? `${s.crawled}/${s.total}` : `${s.crawled}`;
      const note = live ? "running" : nextStep(s.state);
      lines.push(
        `  ${pad(r.config, 18)} ${theme.fg(colour, pad(STATE_LABEL[s.state], 13))} ${dim(pad(counts, 9))} ${dim(note)}`,
      );
    }
  }

  lines.push("");
  lines.push(theme.fg("toolTitle", "archives"));
  if (!inv.archives.length) lines.push(dim("  none yet"));
  for (const a of inv.archives) {
    const p = a.provenance;
    const bits: string[] = [];
    if (p?.pages?.total) bits.push(`${p.pages.crawled}/${p.pages.total} pages`);
    if (p?.limitHit) bits.push(`truncated at pageLimit ${p.pageLimit ?? "?"}`);
    if (a.kind === "warc-dir") bits.push("warc directory, no wacz");
    if (p?.crawler) bits.push(`crawler ${p.crawler}`);
    lines.push(`  ${pad(rel(a.path), 30)} ${dim(pad(humanBytes(a.bytes), 7))} ${dim(bits.join(" · "))}`);
  }

  const tail: string[] = [];
  if (inv.profiles.length) tail.push(`${inv.profiles.length} profile(s)`);
  if (inv.failed.count) tail.push(theme.fg("warning", `${inv.failed.count} failed run(s) ${humanBytes(inv.failed.bytes)}`));
  if (inv.free !== undefined) {
    // The crawler aborts outright when the disk fills mid-crawl.
    const low = inv.free < 5 * 1024 ** 3;
    tail.push(theme.fg(low ? "error" : "dim", `${humanBytes(inv.free)} free`));
  }
  if (inv.legacyCollections.length) tail.push(`${inv.legacyCollections.length} crawl(s) in ./collections (outside the store)`);
  if (tail.length) {
    lines.push("");
    lines.push("  " + tail.join(dim(" · ")));
  }
  if (inv.orphans.length) {
    lines.push("  " + theme.fg("warning", `no matching config: ${inv.orphans.join(", ")}`));
  }
  return lines;
}

/** Compact inventory for the model: the same facts, without the table. */
export function inventoryForModel(inv: Inventory): string {
  const parts: string[] = [`store ${inv.store.root}`];

  parts.push(
    inv.configs.length
      ? `configs: ${inv.configs.map((c) => (c.collection === c.name ? c.name : `${c.name}→${c.collection}`)).join(", ")}`
      : "no configs yet",
  );
  if (inv.neverRun.length) parts.push(`never run: ${inv.neverRun.join(", ")}`);
  for (const r of inv.runs) {
    parts.push(`${r.config}: ${STATE_LABEL[r.stats.state]} ${r.stats.crawled}/${r.stats.total} — ${nextStep(r.stats.state)}`);
  }
  for (const a of inv.archives) {
    const p = a.provenance;
    parts.push(
      `archive ${a.collection} ${humanBytes(a.bytes)}${a.kind === "warc-dir" ? " (warc dir, no wacz)" : ""}` +
        (p?.limitHit ? " (truncated at pageLimit)" : ""),
    );
  }
  if (inv.running.length) parts.push(`containers running: ${inv.running.join(", ")}`);
  if (inv.failed.count) parts.push(`${inv.failed.count} failed run(s) taking ${humanBytes(inv.failed.bytes)}`);
  if (inv.profiles.length) parts.push(`profiles: ${inv.profiles.map((p) => p.name).join(", ")}`);
  if (inv.free !== undefined) parts.push(`${humanBytes(inv.free)} free`);
  if (inv.legacyCollections.length) {
    parts.push(`outside the store, in ./collections: ${inv.legacyCollections.join(", ")}`);
  }
  if (inv.orphans.length) parts.push(`no matching config: ${inv.orphans.join(", ")}`);
  return parts.join(" · ");
}
