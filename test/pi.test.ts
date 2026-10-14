/**
 * Finding the pi btrix was installed with.
 *
 * This had never worked. pi's `exports` does not list `./package.json` and
 * declares only the `import` condition for `.`, so the launcher's
 * `require.resolve("<pkg>/package.json")` threw ERR_PACKAGE_PATH_NOT_EXPORTED
 * on every install -- as did plain `require.resolve("<pkg>")`, so no CJS route
 * existed at all. The throw landed in a catch meant for "not installed as a
 * dependency", and a release that bundles an exact pi silently ran whatever pi
 * was on PATH, or told the user to go and install one.
 *
 * The tests that matter here are the positive ones: that a checkout finds the
 * pi in its own node_modules, and that the pi it finds is the version
 * package.json pins. A test for the fallback alone would have passed
 * throughout the bug.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findPi } from "../src/pi.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const manifest = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The resolved cli, or a failure that names what went wrong rather than a type error. */
const cliOf = (result: { prefix: string[] }): string => {
  const [cli] = result.prefix;
  if (!cli) throw new Error("findPi returned no cli path, so it fell back to PATH");
  return cli;
};

describe("findPi", () => {
  it("finds the pi in node_modules rather than falling back to PATH", () => {
    const result = findPi();
    // The fallback is `{ command: "pi", prefix: [] }`, which is what every
    // install used to get.
    expect(result.command).toBe(process.execPath);
    expect(result.prefix).toHaveLength(1);
    expect(fs.existsSync(cliOf(result))).toBe(true);
  });

  it("runs the pi version package.json pins", () => {
    const cli = cliOf(findPi());
    // Walk back out of the resolved cli to the package that owns it, the same
    // way the launcher does, and check it against the dependency range. The
    // pin is exact, so this is equality; it is the claim the launcher's
    // comment makes -- "a btrix release is pinned to a pi it was tested
    // against" -- and nothing was checking it.
    let dir = path.dirname(cli);
    while (!fs.existsSync(path.join(dir, "package.json")) || manifest(path.join(dir, "package.json")).name !== PI_PACKAGE) {
      const up = path.dirname(dir);
      expect(up).not.toBe(dir);
      dir = up;
    }
    const pinned = manifest(path.join(ROOT, "package.json")).dependencies[PI_PACKAGE];
    expect(manifest(path.join(dir, "package.json")).version).toBe(pinned);
  });

  it("points at the cli pi itself declares, not a guessed path", () => {
    const cli = cliOf(findPi());
    const root = path.resolve(ROOT, "node_modules", PI_PACKAGE);
    const { bin } = manifest(path.join(root, "package.json"));
    const rel = typeof bin === "string" ? bin : bin.pi;
    expect(path.resolve(cli)).toBe(path.resolve(root, rel));
  });

  it("falls back to PATH when pi is not installed as a dependency", () => {
    // A checkout run with `npm link` has no pi of its own to find.
    const absent = () => {
      throw Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" });
    };
    expect(findPi(absent)).toEqual({ command: "pi", prefix: [] });
  });

  it("falls back when the resolved entry belongs to no pi package", () => {
    // Resolution succeeding tells us nothing on its own: the walk up has to
    // find a package.json that names pi, or the launcher would hand Node an
    // entry point from whatever package happened to be there.
    const elsewhere = () => fileURLToPath(new URL("pi.test.ts", import.meta.url).href);
    expect(findPi(elsewhere)).toEqual({ command: "pi", prefix: [] });
  });
});
