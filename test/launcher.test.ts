/**
 * The launcher. Two things it must do without pi's help: answer --help as
 * btrix rather than as pi, and be loadable by plain Node -- it runs before
 * any TypeScript transform exists, and Node will not strip types under
 * node_modules, which is how an installed release came to not start at all.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, BTRIX_TOOLS, HELPER_TOOLS } from "../src/toolnames.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "btrix.js");

/** Run the launcher with an agent dir it cannot disturb. */
const btrix = (args: string[]) =>
  run(process.execPath, [BIN, ...args], {
    env: { ...process.env, BTRIX_AGENT_DIR: path.join(ROOT, "node_modules", ".cache", "btrix-test-agent") },
  });

describe("--help", () => {
  it("answers as btrix, not as pi", async () => {
    const { stdout } = await btrix(["--help"]);
    expect(stdout).toContain("btrix");
    // pi's own help calls itself pi, documents flags btrix does not use, and
    // advertises bash -- which btrix deliberately does not grant.
    expect(stdout).not.toContain("pi - AI coding assistant");
    expect(stdout).not.toMatch(/\bbash\b/);
  });

  it("documents btrix's own flag and environment", async () => {
    const { stdout } = await btrix(["--help"]);
    for (const expected of ["--dir", "BTRIX_DIR", "BTRIX_AGENT_DIR", "BTRIX_CRAWLER_VERSION", "BTRIX_CHROME"]) {
      expect(stdout, expected).toContain(expected);
    }
  });

  it("says the pass-through flags are passed through", async () => {
    const { stdout } = await btrix(["--help"]);
    // Reimplementing --session or -c would be worse than forwarding them, so
    // the help has to admit they come from underneath.
    expect(stdout).toContain("--session");
    expect(stdout).toContain("passed through");
  });

  it("answers -h too", async () => {
    const { stdout } = await btrix(["-h"]);
    expect(stdout).toContain("usage");
  });

  it("exits 0, so it is not mistaken for a usage error", async () => {
    // execFile rejects on a non-zero exit, so reaching here is the assertion.
    await expect(btrix(["--help"])).resolves.toBeTruthy();
  });
});

describe("--version", () => {
  it("prints btrix's version, not the runtime's", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const { stdout } = await btrix(["--version"]);
    expect(stdout.trim()).toBe(`btrix ${pkg.version}`);
  });

  it("answers -V too", async () => {
    const { stdout } = await btrix(["-V"]);
    expect(stdout).toContain("btrix ");
  });
});

describe("the modules the launcher loads before pi exists", () => {
  it("are plain JavaScript, or an installed release cannot start", async () => {
    // Node refuses to strip types for files under node_modules. `npm link`
    // hides this, because the symlink resolves outside node_modules.
    const launcher = fs.readFileSync(BIN, "utf8");
    const imported = [...launcher.matchAll(/await import\(path\.join\(PKG, "src", "([^"]+)"\)\)/g)].map((m) => m[1]!);
    expect(imported.length).toBeGreaterThan(0);
    for (const file of imported) {
      expect(file, file).toMatch(/\.js$/);
      expect(fs.existsSync(path.join(ROOT, "src", file)), file).toBe(true);
    }
  });

  it("really do load under plain Node", async () => {
    // The check that would have caught the release bug: no transform, no
    // bundler, just node importing the file the launcher imports.
    const { stdout } = await run(process.execPath, [
      "-e",
      'import("./src/toolnames.js").then(m => process.stdout.write(String(m.ALL_TOOLS.length)))',
    ], { cwd: ROOT });
    expect(Number(stdout)).toBe(ALL_TOOLS.length);
  });

  it("carry no TypeScript-only syntax", () => {
    // Comments stripped first: both files talk about `as const` in prose,
    // explaining why they cannot use it.
    const code = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const file of ["toolnames.js", "agentdir.js"]) {
      const src = code(fs.readFileSync(path.join(ROOT, "src", file), "utf8"));
      // `as const` parses under tsc and not under node, so it is exactly the
      // kind of thing that passes `npm run check` and breaks the binary.
      expect(src, file).not.toMatch(/\bas const\b/);
      expect(src, file).not.toMatch(/^\s*(export\s+)?interface\s/m);
      // A type annotation on a parameter or a return would fail the same way.
      expect(src, file).not.toMatch(/function\s+\w+\s*\([^)]*:\s*\w/);
    }
  });
});

describe("the tool list the launcher hands to pi", () => {
  it("is the btrix tools plus the helpers, and no shell", () => {
    expect(ALL_TOOLS).toEqual([...BTRIX_TOOLS, ...HELPER_TOOLS]);
    const granted: readonly string[] = ALL_TOOLS;
    expect(granted).not.toContain("bash");
    expect(granted).not.toContain("powershell");
  });
});
