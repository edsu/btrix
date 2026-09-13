/**
 * Reading and summarising a crawl's page index.
 *
 * `pages/pages.jsonl` and `pages/extraPages.jsonl` are the crawler's own record
 * of what it captured, one JSON object per line after a header line. Real
 * records carry url, title, HTTP status, mime, loadState, depth and — when the
 * config set `text: to-pages` — the extracted page text.
 *
 * The point of this module is to surface *candidates*, not verdicts. Whether a
 * page is real content or an anti-bot interstitial is a semantic judgement
 * about a particular site, which the model should make; "eleven pages share one
 * title and have 180 characters of text each" is arithmetic, which it should
 * not have to do by reading files.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PageRecord {
  url: string;
  title?: string;
  status?: number;
  mime?: string;
  loadState?: number;
  depth?: number;
  seed?: boolean;
  /** Length of the extracted text, when the crawl captured any. */
  textLength?: number;
}

export interface Counted<T> {
  value: T;
  count: number;
}

export interface PagesReport {
  seedPages: number;
  extraPages: number;
  total: number;
  /** Whether any page carried text at all — `text: to-pages` was off if not. */
  hasText: boolean;
  medianTextLength?: number;
  /** Longest captured page, which makes a skewed distribution visible. */
  maxTextLength?: number;
  hosts: Counted<string>[];
  seedHost?: string;
  /** Pages whose host is not the seed's, a sample. */
  offHost: PageRecord[];
  statuses: Counted<number>[];
  /** Non-2xx pages, a sample. */
  notOk: PageRecord[];
  mimes: Counted<string>[];
  /** Titles shared by more than one page, most repeated first. */
  repeatedTitles: { title: string; count: number; sample: string[] }[];
  /** Pages with suspiciously little text, a sample, with the threshold used. */
  thinPages: PageRecord[];
  thinThreshold?: number;
  emptyText: number;
  /** loadState below a full load, a sample. */
  partialLoads: PageRecord[];
  truncated: boolean;
}

const SAMPLE = 8;

function tally<T>(values: T[]): Counted<T>[] {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function quantile(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i]!;
}

function host(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** One .jsonl file. The first line is a format header, not a page. */
export function parsePagesJsonl(text: string): PageRecord[] {
  const out: PageRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // The header has `format` and no url; skip it rather than counting it.
    if (typeof d.url !== "string") continue;
    const text = typeof d.text === "string" ? d.text : undefined;
    out.push({
      url: d.url,
      title: typeof d.title === "string" ? d.title : undefined,
      status: typeof d.status === "number" ? d.status : undefined,
      mime: typeof d.mime === "string" ? d.mime : undefined,
      loadState: typeof d.loadState === "number" ? d.loadState : undefined,
      depth: typeof d.depth === "number" ? d.depth : undefined,
      seed: d.seed === true,
      textLength: text === undefined ? undefined : text.length,
    });
  }
  return out;
}

export interface ReadPagesResult {
  seed: PageRecord[];
  extra: PageRecord[];
  found: boolean;
}

/** Read a collection directory's page index. */
export function readPages(collectionDir: string): ReadPagesResult {
  const read = (file: string): PageRecord[] => {
    try {
      return parsePagesJsonl(fs.readFileSync(path.join(collectionDir, "pages", file), "utf8"));
    } catch {
      return [];
    }
  };
  const seed = read("pages.jsonl");
  const extra = read("extraPages.jsonl");
  return { seed, extra, found: fs.existsSync(path.join(collectionDir, "pages")) };
}

export function analyzePages(result: ReadPagesResult): PagesReport {
  const all = [...result.seed, ...result.extra];
  const withText = all.filter((p) => p.textLength !== undefined);
  const lengths = withText.map((p) => p.textLength!);
  const med = quantile(lengths, 0.5);
  const max = lengths.length ? Math.max(...lengths) : undefined;

  const hosts = tally(all.map((p) => host(p.url)).filter((h): h is string => !!h));
  const seedHost = result.seed.length ? host(result.seed[0]!.url) : hosts[0]?.value;

  // Thin pages: well under the typical page for this crawl, and short in
  // absolute terms. Both, because a site of genuinely short pages should not
  // light up, and a crawl of two pages has no useful spread.
  //
  // Measured against a high percentile, not the median. When bot mitigation
  // catches most of a crawl the interstitial *is* the median — and the 75th
  // percentile too, once three quarters of pages are blocked — so comparing
  // against either hides exactly what we are looking for. The 90th resists
  // that, while still not being driven by one unusually long page the way a
  // plain maximum would be.
  const upper = quantile(lengths, 0.9);
  const thinThreshold = upper !== undefined ? Math.min(600, Math.max(120, Math.round(upper / 8))) : undefined;
  const thin =
    thinThreshold !== undefined
      ? withText.filter((p) => p.textLength! > 0 && p.textLength! < thinThreshold)
      : [];

  const titles = tally(all.map((p) => p.title).filter((t): t is string => !!t && t.trim().length > 0));

  return {
    seedPages: result.seed.length,
    extraPages: result.extra.length,
    total: all.length,
    hasText: withText.length > 0,
    medianTextLength: med,
    maxTextLength: max,
    hosts,
    seedHost,
    offHost: seedHost ? all.filter((p) => host(p.url) && host(p.url) !== seedHost).slice(0, SAMPLE) : [],
    statuses: tally(all.map((p) => p.status).filter((s): s is number => typeof s === "number")),
    notOk: all.filter((p) => typeof p.status === "number" && (p.status < 200 || p.status >= 300)).slice(0, SAMPLE),
    mimes: tally(all.map((p) => p.mime).filter((m): m is string => !!m)),
    repeatedTitles: titles
      .filter((t) => t.count > 1)
      .slice(0, SAMPLE)
      .map((t) => ({
        title: t.value,
        count: t.count,
        sample: all.filter((p) => p.title === t.value).slice(0, 3).map((p) => p.url),
      })),
    thinPages: thin.slice(0, SAMPLE),
    thinThreshold,
    emptyText: withText.filter((p) => p.textLength === 0).length,
    partialLoads: all.filter((p) => typeof p.loadState === "number" && p.loadState < 4).slice(0, SAMPLE),
    truncated: thin.length > SAMPLE,
  };
}
