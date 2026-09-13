/**
 * Reading the few keys of a crawl config that btrix needs.
 *
 * Line-oriented rather than a YAML parse, as the old list.sh was: these are the
 * only keys wanted, and one key is not worth a YAML dependency. The cost is
 * that deeply nested or flow-style configs may not yield a seed, which is why
 * everything here is optional.
 */

import * as fs from "node:fs";

export interface ConfigSummary {
  /** Config name, without extension. */
  name: string;
  path: string;
  /** `collection:`, which need not match the filename. */
  collection: string;
  seed?: string;
  scopeType?: string;
  pageLimit?: number;
  /** Custom behavior filenames referenced by `customBehaviors`. */
  behaviors: string[];
  generateWacz: boolean;
  /** `text: to-pages…`, which ReplayWeb.page needs for full-text search. */
  textToPages: boolean;
}

function first(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  const raw = m?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
  return raw && !raw.startsWith("#") ? raw : undefined;
}

export function readConfig(path: string, name: string): ConfigSummary {
  let text = "";
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    // Unreadable config still deserves a row in the inventory.
  }

  const behaviors = [...text.matchAll(/behaviors\/([^\s"']+\.js)/g)].map((m) => m[1]!);
  const limit = first(text, /^\s*pageLimit:\s*(\d+)/m);
  const generate = first(text, /^\s*generateWACZ:\s*(\S+)/m);
  const textOpt = first(text, /^\s*text:\s*(\S+)/m);

  return {
    name,
    path,
    collection: first(text, /^\s*collection:\s*(.+?)\s*$/m) ?? name,
    seed: first(text, /^\s*-?\s*url:\s*(\S+)/m),
    scopeType: first(text, /^\s*scopeType:\s*(\S+)/m),
    pageLimit: limit ? Number.parseInt(limit, 10) : undefined,
    behaviors: [...new Set(behaviors)],
    // The crawler's own default is false, but every btrix-scaffolded config
    // sets it; absent means "no wacz will appear", which list must not hide.
    generateWacz: generate === "true",
    textToPages: !!textOpt?.includes("to-pages"),
  };
}
