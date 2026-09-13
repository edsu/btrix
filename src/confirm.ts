/**
 * Questions asked directly rather than through the model.
 *
 * Owning the interface means a question costs nothing: "which of these three
 * archives?" can be a picker instead of a turn spent replying "several: a, b,
 * c — say which". And the most expensive mistake in this domain, a scope wider
 * than intended with no page limit, can be caught at the one moment it is
 * still cheap.
 */

import type { ConfigSummary } from "./config.ts";
import { humanBytes } from "./sizes.ts";

/** The dialog surface we need, so this module needs no harness to test. */
export interface Asker {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

export type ScopeVerdict = { proceed: true } | { proceed: false; reason: string };

/** Scope in words, since `host` reads harmlessly and does not behave that way. */
export function describeScope(config: ConfigSummary): string {
  const seed = config.seed ?? "the seed url";
  switch (config.scopeType) {
    case "page":
      return `${seed} and nothing else`;
    case "prefix":
      return `${seed} and anything beneath its path`;
    case "host":
      try {
        return `every page on ${new URL(seed).host}`;
      } catch {
        return "every page on the seed's host";
      }
    case "domain":
      try {
        return `every page on ${new URL(seed).host} and its subdomains`;
      } catch {
        return "every page on the seed's domain and its subdomains";
      }
    default:
      return `${seed} (scope not set, so the crawler's default applies)`;
  }
}

/** Whether this config could plausibly run away. */
export function isOpenEnded(config: ConfigSummary): boolean {
  return !config.pageLimit && (config.scopeType === "host" || config.scopeType === "domain");
}

/**
 * Ask before a crawl that could run for hours, and before one that will fill
 * the disk. Both are mistakes discovered far too late otherwise.
 */
export async function confirmCrawl(
  ask: Asker,
  config: ConfigSummary,
  free: number | undefined,
  lowDiskBytes: number,
): Promise<ScopeVerdict> {
  if (free !== undefined && free < lowDiskBytes) {
    const ok = await ask.confirm(
      "Low disk space",
      `Only ${humanBytes(free)} free. Browsertrix aborts outright when the disk fills mid-crawl.\n\n` +
        `Start ${config.name} anyway?`,
    );
    if (!ok) return { proceed: false, reason: "not enough free disk space" };
  }

  if (isOpenEnded(config)) {
    const lines = [
      `scope   ${config.scopeType} — ${describeScope(config)}`,
      "limit   none",
      "",
      "This could run for hours and put real load on the site.",
    ].join("\n");
    const choice = await ask.select(`Crawl ${config.name}?\n\n${lines}`, [
      "Crawl anyway",
      "Cancel and add a page limit",
    ]);
    if (choice !== "Crawl anyway") {
      return {
        proceed: false,
        reason:
          `the scope is ${config.scopeType} with no pageLimit. Suggest adding one — 25 is a good first ` +
          "attempt at an unfamiliar site — then run it again.",
      };
    }
  }

  return { proceed: true };
}

/**
 * Pick one when several fit. Returns undefined when the user dismisses, which
 * a caller should treat as "leave it alone", not as an error.
 */
export async function pickOne(
  ask: Asker,
  title: string,
  options: string[],
): Promise<string | undefined> {
  if (options.length <= 1) return options[0];
  return ask.select(title, options);
}
