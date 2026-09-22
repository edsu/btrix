/**
 * Rendering. Two consumers, one source of truth.
 *
 * Discipline: facts here, diagnosis in the model. The widget says
 * "no new page 4m", never "stalled" — stall detection is a heuristic with a
 * timeout, and moving it from prose into TypeScript must not launder a guess
 * into certainty. Anything uncertain is carried by colour, not by adjective.
 */

import type { Inventory } from "./inventory.ts";
import { WORDMARK } from "./wordmark.ts";
import { SAMPLE, type PagesReport } from "./pages.ts";
import { nextStep } from "./inventory.ts";
import { humanBytes, humanDuration } from "./sizes.ts";
import { untrusted, UNTRUSTED_NOTE } from "./untrusted.ts";
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

/**
 * Whether work is still happening. Rates only mean something while it is, and
 * a review of a live crawl is a review of a partial capture.
 */
export function isLive(s: CrawlStats): boolean {
  return (
    s.containerRunning || s.state === "crawling" || s.state === "post-crawl" || s.state === "generating-wacz"
  );
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
  if (s.state === "crawling" && s.pending[0]) parts.push(`fetching ${untrusted(s.pending[0].url)}`);
  if (s.waczPath) parts.push(`wacz at ${s.waczPath}`);
  if (s.state === "stopped") parts.push("no container running and no wacz — the crawl ended early");
  if (s.lastProblem) parts.push(`last warning/error: ${untrusted(s.lastProblem)}`);
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

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * How many pages a sampled list stands for, and a note when the list printed
 * below it is only part of that.
 *
 * The lists in a report are capped at `SAMPLE`, so their length is a floor:
 * rendering it as the count turns "500 of 520 pages were blocked" into "8
 * non-2xx pages", which is the opposite of the judgement the review is for.
 * Reports read back from sidecars written before `totals` existed know only
 * the sample, and a full sample then says "8+".
 */
function counted(
  r: PagesReport,
  key: keyof NonNullable<PagesReport["totals"]>,
  sample: unknown[],
): { count: string; note: string } {
  const n = r.totals?.[key];
  if (n === undefined) return { count: `${sample.length}${sample.length >= SAMPLE ? "+" : ""}`, note: "" };
  return { count: `${n}`, note: n > sample.length ? ` (first ${sample.length} shown)` : "" };
}

/**
 * The review, written for the model to judge rather than to relay.
 *
 * Every line here is arithmetic over the crawler's own page index. The
 * questions it cannot answer — is this title content or a block page for *this*
 * site, is 180 characters short for *these* pages — are exactly the ones left
 * open, with the numbers attached so they can be answered.
 */
export function reviewForModel(name: string, r: PagesReport): string {
  const lines: string[] = [
    `${name}: ${r.total} pages captured (${r.seedPages} seed, ${r.extraPages} discovered)`,
  ];

  if (!r.hasText) {
    // Without page text there is nothing to judge content by, and this is also
    // why replay search will find nothing.
    lines.push(
      "No page text was captured, so the crawl ran without `text: to-pages`. " +
        "Interstitials cannot be detected from the page index, and replay will not be searchable.",
    );
  } else {
    // Median and longest together, so a bimodal crawl — real pages plus a
    // repeated block page — is visible instead of averaged away.
    lines.push(
      `page text: median ${r.medianTextLength} chars, longest ${r.maxTextLength} chars` +
        (r.maxTextLength !== undefined &&
        r.medianTextLength !== undefined &&
        r.maxTextLength > 10 * Math.max(1, r.medianTextLength)
          ? " — a wide spread like this usually means most pages did not capture real content"
          : ""),
    );
    if (r.emptyText) lines.push(`${r.emptyText} page(s) captured no text at all`);
    if (r.thinPages.length) {
      const thin = counted(r, "thinPages", r.thinPages);
      lines.push(
        `${thin.count} page(s) under ${r.thinThreshold} chars${thin.note} — ` +
          `judge whether these are real content or a block page (${UNTRUSTED_NOTE}):\n` +
          r.thinPages
            .map((p) => `  ${p.textLength} chars · ${untrusted(p.title, "(no title)")} · ${untrusted(p.url)}`)
            .join("\n"),
      );
    }
  }

  if (r.repeatedTitles.length) {
    // Many pages sharing one title is the signature of an interstitial, and
    // also of a legitimately templated site. The model has to decide which.
    lines.push(
      `titles shared by several pages — an interstitial looks like this, but so does a templated site
(${UNTRUSTED_NOTE}):\n` +
        r.repeatedTitles
          .map((t) => `  ${t.count}× ${untrusted(t.title)} e.g. ${untrusted(String(t.sample[0] ?? ""))}`)
          .join("\n"),
    );
  }

  const statuses = r.statuses.map((s) => `${s.value}×${s.count}`).join(" ");
  if (statuses) lines.push(`http statuses: ${statuses}`);
  if (r.notOk.length) {
    const nok = counted(r, "notOk", r.notOk);
    lines.push(
      `${nok.count} non-2xx page(s)${nok.note}:\n` +
        r.notOk.map((p) => `  ${p.status} ${untrusted(p.url)}`).join("\n"),
    );
  }

  if (r.hosts.length > 1) {
    lines.push(
      `${r.hosts.length} hosts, seed host ${r.seedHost ?? "?"}: ${r.hosts.map((h) => `${h.value}×${h.count}`).join(" ")}` +
        (r.offHost.length ? " — check whether the scope was wider than intended" : ""),
    );
  }

  if (r.partialLoads.length) {
    const partial = counted(r, "partialLoads", r.partialLoads);
    lines.push(
      `${partial.count} page(s) did not fully load (loadState below 4)${partial.note}:\n` +
        r.partialLoads.map((p) => `  loadState ${p.loadState} ${untrusted(p.url)}`).join("\n"),
    );
  }

  const mimes = r.mimes.filter((m) => m.value !== "text/html");
  if (mimes.length) lines.push(`non-html captures: ${mimes.map((m) => `${m.value}×${m.count}`).join(" ")}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export interface StartupInfo {
  inv: Inventory;
  engine: { usable: boolean; bin?: string; problem?: string };
  model?: string;
  adopted: string[];
  /** Collections promoted at startup because they finished with btrix closed. */
  promoted?: string[];
  /** Whether box-drawing characters will render. Defaults to assuming yes. */
  unicode?: boolean;
  /** Pre-coloured wordmark lines. Defaults to the uncoloured wordmark. */
  wordmark?: string[];
}

/** "1 archive" / "2 archives", rather than "1 archive(s)". */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Visible width, ignoring colour sequences. */
function visible(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}


/** Whether the terminal is likely to render box-drawing characters. */
export function supportsUnicode(env: Record<string, string | undefined> = process.env): boolean {
  const locale = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`;
  return /utf-?8/i.test(locale) || env.TERM_PROGRAM === "vscode" || env.WT_SESSION !== undefined;
}

/**
 * One row per crawl, for the startup banner: what is here and where each thing
 * got to. A condensed form of the inventory — enough to see at a glance, with
 * `/btrix` for the whole table.
 */
export function overviewLines(inv: Inventory, theme: ThemeLike = plainTheme, limit = 5): string[] {
  const dim = (t: string) => theme.fg("dim", t);

  interface Row {
    name: string;
    state: string;
    colour: string;
    counts: string;
    size: string;
    rank: number;
  }

  const rows: Row[] = inv.configs.map((c) => {
    const run = inv.runs.find((r) => r.config === c.name);
    const archive = inv.archives.find((a) => a.collection === c.collection);
    const live = inv.running.includes(c.name);
    const s = run?.stats;

    const state = live ? "crawling" : s ? STATE_LABEL[s.state] : archive ? "done" : "never run";
    const colour = live ? "accent" : state === "done" ? "success" : state === "never run" ? "dim" : "warning";
    const pages = archive?.provenance?.pages;
    return {
      name: c.collection === c.name ? c.name : `${c.name} → ${c.collection}`,
      state,
      colour,
      counts: s?.total ? `${s.crawled}/${s.total}` : pages?.total ? `${pages.crawled}/${pages.total}` : "",
      size: archive ? humanBytes(archive.bytes) : "",
      // Live crawls first, then finished archives, then runs that ended
      // without one — a stopped crawl with partial output is more interesting
      // than a config nobody has run yet.
      rank: live ? 0 : archive ? 1 : s ? 2 : 3,
    };
  });

  // An archive whose config is gone still belongs in the picture.
  for (const a of inv.archives) {
    if (inv.configs.some((c) => c.collection === a.collection)) continue;
    rows.push({
      name: a.collection,
      state: "no config",
      colour: "warning",
      counts: a.provenance?.pages?.total ? `${a.provenance.pages.crawled}/${a.provenance.pages.total}` : "",
      size: humanBytes(a.bytes),
      rank: 1,
    });
  }

  if (!rows.length) return [];
  rows.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const shown = rows.slice(0, limit);
  const width = Math.min(34, Math.max(...shown.map((r) => r.name.length)));
  const out = shown.map((r) => {
    const row =
      `  ${theme.fg("text", r.name.padEnd(width))}  ${theme.fg(r.colour, r.state.padEnd(10))} ` +
      `${dim(r.counts.padStart(8))}  ${dim(r.size)}`;
    // Trim the whole row: the state column pads too, so trimming only the tail
    // fragment leaves its padding behind.
    return row.replace(/\s+$/, "");
  });
  if (rows.length > shown.length) {
    out.push("  " + dim(`+${rows.length - shown.length} more — /btrix for the full inventory`));
  }
  return out;
}

/** What to suggest doing next, from what is actually in the store. */
export function nextStepHint(inv: Inventory, adopted: string[]): string {
  if (adopted.length) return `${adopted.join(", ")} is still crawling — watch the progress below.`;
  const ready = inv.neverRun[0];
  if (ready) return `Ready to crawl: say "crawl ${ready}".`;
  const archive = inv.archives[0]?.collection;
  if (archive) return `Say "replay ${archive}" to look at an archive, or name another site to capture.`;
  return 'Tell me a site to archive — for example, "archive the news section of library.stanford.edu".';
}

/**
 * The startup banner, replacing the harness's own.
 *
 * The default one advertises the harness — its logo, its keybindings, and an
 * invitation to ask it about itself — none of which a person who installed a
 * web archiving tool has any use for.
 *
 * What goes here instead is chosen by "would this change what you do next":
 * where the store is, whether a crawl is already running, whether the container
 * engine will actually work, and anything quietly costing disk. Kept short.
 */
export function startupLines(info: StartupInfo, theme: ThemeLike = plainTheme): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const sep = dim(" · ");
  const { inv } = info;

  const head = [dim(inv.store.root)];
  if (inv.free !== undefined) head.push(dim(`${humanBytes(inv.free)} free`));
  if (info.model) head.push(dim(info.model.replace(/^store .*? · /, "")));

  const empty = !inv.configs.length && !inv.archives.length;
  const facts: string[] = [];
  // "0 configs" adds nothing next to the invitation below.
  if (!empty) facts.push(dim(plural(inv.configs.length, "config")));
  if (inv.archives.length) {
    const bytes = inv.archives.reduce((n, a) => n + (a.bytes ?? 0), 0);
    facts.push(dim(`${plural(inv.archives.length, "archive")} ${humanBytes(bytes)}`));
  }
  if (inv.profiles.length) facts.push(dim(plural(inv.profiles.length, "login profile")));

  // The wordmark carries the greeting beside it, so the banner reads as a
  // welcome rather than a status dump.
  const beside = [
    "",
    dim("high-fidelity web archives"),
    dim("Browsertrix Crawler, driven by conversation"),
    "",
  ];
  const art = info.wordmark ?? WORDMARK;
  const width = Math.max(...art.map(visible)) + 4;
  const pad = (a: string) => a + " ".repeat(Math.max(2, width - visible(a)));
  const lines = art.map((a, i) => (beside[i] ? pad(a) + beside[i] : a).replace(/\s+$/, ""));

  lines.push("");
  lines.push("  " + head.join(sep));
  if (facts.length) lines.push("  " + facts.join(sep));

  const overview = overviewLines(inv, theme);
  if (overview.length) {
    lines.push("");
    lines.push(...overview);
  }

  // Not a warning: nothing went wrong, but an archive appearing in out/ that
  // the user never saw finish deserves a sentence rather than silence.
  if (info.promoted?.length) {
    lines.push("");
    lines.push(
      "  " +
        theme.fg(
          "text",
          `${plural(info.promoted.length, "archive")} finished while btrix was closed, now in out/ — ${info.promoted.join(", ")}`,
        ),
    );
  }

  const warnings: string[] = [];
  if (!info.engine.usable && info.engine.problem) warnings.push(info.engine.problem);
  if (inv.failed.count) {
    warnings.push(
      `${plural(inv.failed.count, "failed run")} holding ${humanBytes(inv.failed.bytes)} — ask me to clear them`,
    );
  }
  if (inv.free !== undefined && inv.free < 5 * 1024 ** 3) {
    warnings.push("less than 5G free; the crawler aborts outright when the disk fills mid-crawl");
  }
  for (const w of warnings) lines.push("  " + theme.fg(info.engine.usable ? "warning" : "error", `⚠ ${w}`));

  lines.push("");
  if (info.engine.usable) {
    lines.push("  " + theme.fg("text", nextStepHint(inv, info.adopted)));
  }

  // btrix is a front end; the crawler is Webrecorder's work, and saying so is
  // both accurate and the least this can do. One dim line, every start.
  lines.push(
    "  " +
      dim(`${info.unicode === false ? "<3" : "♥"} Webrecorder builds the crawler — https://opencollective.com/webrecorder`),
  );

  // Only btrix's own affordances, and `/help` for the rest: listing keys that
  // the harness lets people rebind would be inventing an answer.
  lines.push(
    "  " +
      [
        dim("/btrix for the inventory"),
        dim("/replay to open an archive"),
        dim("@ completes names"),
        dim("/help for more"),
      ].join(sep),
  );
  return lines;
}

/**
 * The review for the human. Same facts as `reviewForModel`, but colour carries
 * the severity and the open questions stay phrased as questions — a candidate
 * list is not a verdict, and the rendering should not imply otherwise.
 */
export function renderReview(name: string, r: PagesReport, theme: ThemeLike = plainTheme): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [
    `${theme.fg("text", name)} ${dim(`${r.total} pages · ${r.seedPages} seed · ${r.extraPages} discovered`)}`,
  ];

  if (!r.hasText) {
    lines.push(theme.fg("warning", "  no page text captured — crawled without text: to-pages"));
    lines.push(dim("  interstitials cannot be detected, and replay will not be searchable"));
  } else {
    const skewed =
      r.maxTextLength !== undefined &&
      r.medianTextLength !== undefined &&
      r.maxTextLength > 10 * Math.max(1, r.medianTextLength);
    lines.push(
      `  ${dim(`page text: median ${r.medianTextLength}, longest ${r.maxTextLength} chars`)}` +
        (skewed ? theme.fg("warning", "  ← wide spread: most pages may hold no real content") : ""),
    );
    if (r.emptyText) lines.push(theme.fg("warning", `  ${r.emptyText} page(s) captured no text at all`));
    if (r.thinPages.length) {
      lines.push(
        theme.fg("warning", `  ${counted(r, "thinPages", r.thinPages).count} page(s) under ${r.thinThreshold} chars`) +
          dim(" — content, or a block page?"),
      );
      for (const p of r.thinPages.slice(0, 5)) {
        lines.push(dim(`      ${p.textLength} chars · ${p.title ?? "(no title)"} · ${p.url}`));
      }
    }
  }

  for (const t of r.repeatedTitles.slice(0, 3)) {
    lines.push(theme.fg("warning", `  ${t.count}× "${t.title}"`) + dim(" — interstitial, or a templated site?"));
  }

  if (r.notOk.length) {
    lines.push(theme.fg("error", `  ${counted(r, "notOk", r.notOk).count} non-2xx page(s)`));
    for (const p of r.notOk.slice(0, 3)) lines.push(dim(`      ${p.status} ${p.url}`));
  }
  if (r.hosts.length > 1) {
    lines.push(
      theme.fg("warning", `  ${r.hosts.length} hosts`) +
        dim(` (seed ${r.seedHost ?? "?"}) — was the scope wider than intended?`),
    );
  }
  if (r.partialLoads.length) {
    lines.push(dim(`  ${counted(r, "partialLoads", r.partialLoads).count} page(s) did not fully load`));
  }
  const other = r.mimes.filter((m) => m.value !== "text/html");
  if (other.length) lines.push(dim(`  non-html: ${other.map((m) => `${m.value}×${m.count}`).join(" ")}`));
  return lines;
}
