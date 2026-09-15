/**
 * Where a crawl's files live.
 *
 * One self-contained directory per project: `./btrix/`. Work and output share a
 * tree, so promoting a finished WACZ is always a same-volume rename rather than
 * a cross-device copy — which is why there is no device detection anywhere in
 * here. To put a crawl on another volume you move the whole store with `--dir`,
 * and work and output move together.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Store {
  /** The store root. `./btrix` unless overridden. */
  root: string;
  /** Authored configs and their behaviors. Versionable. */
  configDir: string;
  /** One directory per crawl attempt, each mounted at /crawls. */
  runsDir: string;
  /** Finished WACZs and their provenance sidecars. */
  outDir: string;
  /** Browser login profiles. Mode 0700. */
  profilesDir: string;
  /** Runs that ended without producing a deliverable, kept for inspection. */
  failedDir: string;
  /** Throwaway profile for the local scratch browser. Never your own. */
  chromeProfileDir: string;
  settingsPath: string;
  /** How the root was chosen, for reporting back to the user. */
  source: "flag" | "env" | "existing" | "default";
}

/**
 * Bulk output and credentials are not for version control; authored configs
 * are. Written into the store so the surrounding repository needs no
 * cooperation — and so a `git add -A` cannot sweep up session cookies.
 */
export const STORE_GITIGNORE = `# Written by btrix. Bulk crawl output and browser profiles do not belong in
# version control; config/ is deliberately not ignored, since configs are
# authored files worth keeping.
runs/
out/
profiles/
failed/
chrome-profile/
settings.json
`;

/**
 * Whether a name is safe to build a path inside the store from.
 *
 * Config and profile names arrive from the model and end up in path.join,
 * mkdir and cpSync. Defined here, next to the paths it protects, and shared
 * rather than restated: a validator copied into two files drifts.
 */
export function isSafeStoreName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function storeAt(root: string, source: Store["source"]): Store {
  return {
    root,
    configDir: path.join(root, "config"),
    runsDir: path.join(root, "runs"),
    outDir: path.join(root, "out"),
    profilesDir: path.join(root, "profiles"),
    failedDir: path.join(root, "failed"),
    chromeProfileDir: path.join(root, "chrome-profile"),
    settingsPath: path.join(root, "settings.json"),
    source,
  };
}

/**
 * `--dir` names the store root itself, not a parent, so
 * `btrix --dir /Volumes/archive/sulnews` puts the whole store on that volume.
 */
export function resolveStore(opts: { dir?: string; env?: Record<string, string | undefined>; cwd?: string } = {}): Store {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const flag = opts.dir?.trim();
  if (flag) return storeAt(path.resolve(cwd, flag), "flag");

  const fromEnv = env.BTRIX_DIR?.trim();
  if (fromEnv) return storeAt(path.resolve(cwd, fromEnv), "env");

  const local = path.join(cwd, "btrix");
  return storeAt(local, fs.existsSync(local) ? "existing" : "default");
}

/** Create the store if needed. Idempotent. */
export function ensureStore(store: Store): Store {
  for (const dir of [store.root, store.configDir, store.runsDir, store.outDir, store.failedDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(store.profilesDir, { recursive: true, mode: 0o700 });

  const ignore = path.join(store.root, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, STORE_GITIGNORE);
  return store;
}

/** Sortable, human-readable, and unique enough at one crawl per minute. */
export function runId(config: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${config}-${stamp}`;
}

/**
 * Configs live in the store, but /crawls maps to the run directory, so the
 * config would not be visible inside the container. Copying the whole config
 * directory in solves that and records exactly which config and which custom
 * behaviors produced this run — `customBehaviors` paths like
 * `/crawls/config/behaviors/foo.js` keep resolving.
 */
export function prepareRun(store: Store, config: string, now: Date): string {
  // Reached with the raw name from btrix_run, independently of configPath, and
  // it mkdirs and copies into whatever it is handed. A separator or a `..`
  // here would put the run directory -- which run.sh then bind-mounts at
  // /crawls -- anywhere on the disk.
  if (!isSafeStoreName(config)) throw new Error(`Unsafe config name: ${JSON.stringify(config)}`);
  const dir = path.join(store.runsDir, runId(config, now));
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(store.configDir)) {
    fs.cpSync(store.configDir, path.join(dir, "config"), { recursive: true });
  }
  return dir;
}

/** Run directories for a config, newest first. */
export function runsFor(store: Store, config: string): string[] {
  try {
    return fs
      .readdirSync(store.runsDir)
      .filter((d) => d.startsWith(`${config}-`))
      .sort()
      .reverse()
      .map((d) => path.join(store.runsDir, d));
  } catch {
    return [];
  }
}

/** The run a crawl is writing into: newest run that has a collections dir. */
export function activeRun(store: Store, config: string, collection: string): string | undefined {
  return runsFor(store, config).find((r) => fs.existsSync(path.join(r, "collections", collection)));
}

/**
 * `collection:` in a config need not match the config's filename, and when it
 * does not, looking for `collections/<config-name>` finds nothing forever.
 * Parsed line-wise rather than taking a YAML dependency for one key.
 */
export function collectionFor(configFile: string, fallback: string): string {
  try {
    const text = fs.readFileSync(configFile, "utf8");
    const m = /^\s*collection:\s*(.+?)\s*$/m.exec(text);
    const raw = m?.[1]?.replace(/^["']|["']$/g, "").trim();
    // A commented-out or empty value is not a collection name.
    if (raw && !raw.startsWith("#")) return raw;
  } catch {
    // No readable config: the filename is the best guess available.
  }
  return fallback;
}

/**
 * A top-level ./collections, as produced by the M1 layout or by a hand-run
 * `docker run -v $PWD:/crawls`. btrix never writes here; it only reads, so
 * those crawls still show up in status and list.
 */
export function legacyRoot(cwd: string = process.cwd()): string | undefined {
  const dir = path.join(cwd, "collections");
  return fs.existsSync(dir) ? cwd : undefined;
}
