/**
 * Name completion on `@`.
 *
 * Names are the main thing anyone types here — a config, a collection, an
 * archive — and a typo currently costs a model turn to discover and correct.
 * The inventory already knows every name, so completing them is free.
 */

import type { Inventory } from "./inventory.ts";
import type { Profile } from "./profile.ts";
import { humanBytes } from "./sizes.ts";

export interface NameSuggestion {
  value: string;
  label: string;
  description: string;
}

/** The `@token` immediately before the cursor, if there is one. */
export function tokenBeforeCursor(textBeforeCursor: string): string | undefined {
  const m = /(?:^|[\s(["'])@([^\s@]*)$/.exec(textBeforeCursor);
  return m?.[1];
}

/**
 * Everything nameable, deduplicated and ordered by what the user most likely
 * means: things that exist as output first, then things that could be run.
 */
export function nameSuggestions(inv: Inventory, profiles: Profile[] = []): NameSuggestion[] {
  const out: NameSuggestion[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string, description: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label, description });
  };

  for (const a of inv.archives) {
    const pages = a.provenance?.pages;
    add(
      a.collection,
      a.collection,
      `archive · ${humanBytes(a.bytes)}${pages?.total ? ` · ${pages.crawled}/${pages.total} pages` : ""}` +
        (a.kind === "warc-dir" ? " · warcs only" : ""),
    );
  }

  for (const r of inv.runs) {
    const live = inv.running.includes(r.config);
    add(r.config, r.config, `${live ? "crawling now" : r.stats.state} · ${r.stats.crawled}/${r.stats.total} pages`);
  }

  for (const c of inv.configs) {
    const seed = (c.seed ?? "").replace(/^https?:\/\//, "");
    add(c.name, c.name, `config · ${seed || "no seed"}${c.scopeType ? ` · ${c.scopeType}` : ""}`);
    // A collection name that differs is what the output is actually called, so
    // it is worth completing too.
    if (c.collection !== c.name) add(c.collection, c.collection, `collection of ${c.name}`);
  }

  for (const p of profiles) {
    add(p.name, p.name, `login profile · ${humanBytes(p.bytes)}`);
  }

  return out;
}

/** Subsequence match, so "sn" finds "sulnews". Case-insensitive. */
export function fuzzyMatches(candidate: string, query: string): boolean {
  if (!query) return true;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

export function filterSuggestions(all: NameSuggestion[], query: string): NameSuggestion[] {
  const matched = all.filter((s) => fuzzyMatches(s.value, query));
  // Prefix matches are almost always what was meant, so lift them.
  const q = query.toLowerCase();
  return matched.sort((a, b) => {
    const ap = a.value.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.value.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp;
  });
}

/**
 * Replace the `@token` before the cursor with the chosen name.
 *
 * The `@` is only a trigger, so it is not left in the text: what stays is the
 * bare name, which is exactly what the tools take. A stray `@` reaching a tool
 * as part of a collection name would just have to be stripped again.
 */
export function applyNameCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  value: string,
  prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const before = line.slice(0, cursorCol);
  const after = line.slice(cursorCol);

  // Only replace when the text really does end with the prefix we offered.
  const start = before.endsWith(prefix) ? before.length - prefix.length : before.length;
  const head = before.slice(0, start);
  const next = [...lines];
  next[cursorLine] = head + value + after;
  return { lines: next, cursorLine, cursorCol: (head + value).length };
}
