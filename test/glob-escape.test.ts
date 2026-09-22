/**
 * Whether a glob can reach outside the directory whose path was checked.
 *
 * paths.ts used to assert that it could -- that a pattern is expanded after the
 * path check, so `../../**` would walk out of a directory that passed. That is
 * not what fd and rg do: the pattern is a filter applied while walking the
 * search root, and neither follows one out of it.
 *
 * The reason this is a test and not a comment: "cannot escape" is a claim about
 * those two binaries, not about btrix. The gate's other assumption about how a
 * path gets interpreted -- that `path.resolve` sees what the tool sees -- was
 * wrong for two years' worth of tildes, and nothing failed. So this pins the
 * half of the question that lives outside this repository.
 *
 * Skipped where the binary is absent, which includes CI as currently
 * configured: pi downloads fd into the agent directory on first use, and CI
 * never runs btrix. Install fd and rg in the workflow to enforce it there.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentDir } from "../src/agentdir.js";

const run = promisify(execFile);

/** Wherever pi put it, or a system one. Undefined means the case cannot run. */
function locate(tool: string): string | undefined {
  const downloaded = path.join(resolveAgentDir(), "bin", tool);
  if (fs.existsSync(downloaded)) return downloaded;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, tool);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const fd = locate("fd");
const rg = locate("rg");

/**
 * The arguments pi's `find` builds, so this tests what actually runs rather
 * than a simplified version of it. See core/tools/find.js.
 */
function fdArgs(pattern: string, searchPath: string): string[] {
  const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", "100"];
  let effective = pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      effective = `**/${pattern}`;
    }
  }
  args.push("--", effective, searchPath);
  return args;
}

let dir: string;
let work: string;
let secretDir: string;
let secretFile: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "btrix-glob-")));
  work = path.join(dir, "work");
  secretDir = path.join(dir, "home", ".ssh");
  secretFile = path.join(secretDir, "id_rsa");
  fs.mkdirSync(path.join(work, "sub"), { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(work, "sub", "a.txt"), "ordinary\n");
  fs.writeFileSync(secretFile, "SECRET\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Patterns that would reach the planted key if a glob were a path rather than
// a filter. The tilde one is the case that motivated all of this.
const escapes = ["~/**", "**/~/**", "../home/.ssh/*", "../../**/id_rsa", "/**/id_rsa"];

describe.skipIf(!fd)("fd globs, as pi's find invokes them", () => {
  it("cannot reach a file outside the search root", async () => {
    for (const pattern of escapes) {
      const { stdout } = await run(fd!, fdArgs(pattern, work));
      expect(stdout, `pattern ${pattern}`).not.toContain("id_rsa");
      expect(stdout, `pattern ${pattern}`).not.toContain(secretDir);
    }
  });

  it("would catch a reach, because the same pattern matches one level up", async () => {
    // The anti-vacuity guard. `**/id_rsa` is taken from the list above, so this
    // shows those assertions are held by the search root and not by patterns
    // that could never match anything -- which is how the unicode case in
    // paths.test.ts first got written, green and meaningless.
    const { stdout } = await run(fd!, fdArgs("**/id_rsa", dir));
    expect(stdout).toContain(secretFile);
  });
});

describe.skipIf(!rg)("rg globs, as pi's grep invokes them", () => {
  const search = (glob: string, root: string) =>
    run(rg!, ["--line-number", "--color=never", "--hidden", "--glob", glob, "--", "SECRET", root]);

  it("cannot reach a file outside the search root", async () => {
    for (const glob of escapes) {
      // rg exits 1 with no output when nothing matches, which execFile rejects.
      const stdout = await search(glob, work).then(
        (r) => r.stdout,
        (err: { code?: number; stdout?: string }) => {
          expect(err.code, `pattern ${glob} should be "no match", not an error`).toBe(1);
          return err.stdout ?? "";
        },
      );
      expect(stdout, `pattern ${glob}`).toBe("");
    }
  });

  it("would catch a reach, because the same glob matches one level up", async () => {
    const { stdout } = await search("**/id_rsa", dir);
    expect(stdout).toContain("SECRET");
  });
});
