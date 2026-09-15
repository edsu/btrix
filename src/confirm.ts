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
    case "page-spa":
      return `${seed} and its in-page routes, nothing else`;
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
    case "any":
      return "every link it finds, anywhere — this does not stop at the seed's site";
    case "custom":
      return `${seed} plus whatever scopeIncludeRx matches`;
    default:
      return `${seed} (scope not set, so the crawler's default applies)`;
  }
}

/**
 * Whether this config could plausibly run away.
 *
 * The line is whether the crawl's size is bounded by something the user chose
 * or by something they do not control. `page`, `page-spa` and `prefix` are
 * bounded by a url or a path. `host` and `domain` are bounded only by how big
 * the site turns out to be, which is the thing nobody knows in advance.
 *
 * `any` follows every link anywhere and does not stop at the site, so it
 * belongs here too -- it is strictly wider than `domain`. `custom` is left
 * out: its breadth is whatever `scopeIncludeRx` says, and a hand-written
 * regex is usually a deliberate narrowing, so gating it would ask about
 * configs that are already careful.
 *
 * `extraHops` follows links beyond the scope, off-site included, so it widens
 * even the bounded types -- `prefix` with extraHops is not bounded by the path
 * any more.
 */
export function isOpenEnded(config: ConfigSummary): boolean {
  if (config.pageLimit) return false;
  if (config.extraHops && config.extraHops > 0) return true;
  return config.scopeType === "host" || config.scopeType === "domain" || config.scopeType === "any";
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
      `scope   ${config.scopeType ?? "not set"} — ${describeScope(config)}`,
      ...(config.extraHops
        ? [`hops    extraHops ${config.extraHops} — also follows links this far beyond the scope, off-site included`]
        : []),
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
          `the scope is ${config.scopeType ?? "unset"}${config.extraHops ? ` with extraHops ${config.extraHops}` : ""} ` +
          "and there is no pageLimit. Suggest adding one — 25 is a good first attempt at an unfamiliar site — " +
          "then run it again.",
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
