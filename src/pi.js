/**
 * Finding the pi that btrix was installed with.
 *
 * A btrix release depends on an exact pi version, so that what ships is what
 * was tested. Falling back to a pi on PATH is for a working-tree checkout,
 * where btrix is linked and has no dependency of its own to find.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Plain JavaScript for the same reason as agentdir.js: bin/btrix.js reads this
 * before pi starts, and Node refuses to strip types for files under
 * node_modules. Type-checked via checkJs.
 */

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * @typedef {{ command: string, prefix: string[] }} PiCommand
 */

/**
 * pi's `exports` does not list `./package.json`, and declares only the
 * `import` condition for `.`, so every CJS route to it is closed:
 * `require.resolve("<pkg>/package.json")` and plain `require.resolve("<pkg>")`
 * both throw ERR_PACKAGE_PATH_NOT_EXPORTED. This is why reading the manifest
 * directly looked like it worked and never did -- the throw landed in a catch
 * that treats "not installed" and "installed but unreachable" alike, and every
 * install quietly used a pi from PATH or told the user to go and install one.
 *
 * `import.meta.resolve` matches the `import` condition and returns the entry
 * point. The package root is then the nearest ancestor directory whose
 * package.json names pi -- found by walking up rather than assuming a depth,
 * because where the entry sits inside the package is pi's business and has
 * changed before.
 *
 * @param {(specifier: string) => string} [resolve] injection point for tests
 * @returns {PiCommand}
 */
export function findPi(resolve) {
  try {
    const url = resolve ? resolve(PI_PACKAGE) : import.meta.resolve(PI_PACKAGE);
    const root = packageRoot(fileURLToPath(url));
    if (root) {
      const cli = binPath(root);
      if (cli && fs.existsSync(cli)) return { command: process.execPath, prefix: [cli] };
    }
  } catch {
    // Not installed as a dependency; a checkout run with `npm link` lands here.
  }
  return { command: "pi", prefix: [] };
}

/**
 * The nearest directory at or above `entry` whose package.json is pi's own.
 * The name check matters: the walk would otherwise stop at a nested
 * package.json belonging to something pi bundles.
 *
 * @param {string} entry
 * @returns {string | undefined}
 */
function packageRoot(entry) {
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && readName(manifest) === PI_PACKAGE) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * @param {string} manifest
 * @returns {string | undefined}
 */
function readName(manifest) {
  try {
    return JSON.parse(fs.readFileSync(manifest, "utf8")).name;
  } catch {
    // An unreadable or malformed package.json is not pi's; keep walking.
    return undefined;
  }
}

/**
 * @param {string} root
 * @returns {string | undefined}
 */
function binPath(root) {
  try {
    const { bin } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const rel = typeof bin === "string" ? bin : bin?.pi;
    return rel ? path.join(root, rel) : undefined;
  } catch {
    return undefined;
  }
}
