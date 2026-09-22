/**
 * The read and write scope. This is the gate standing between an injected page
 * title and the user's credentials, so the interesting cases are all the ways a
 * path can look like it is inside the store without being inside it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  refuseGlob,
  refuseRead,
  refuseSearch,
  refuseWrite,
  resolveForCheck,
  type Scope,
  within,
} from "../src/paths.ts";

let dir: string;
let scope: Scope;
let home: string;

beforeEach(() => {
  // realpath, because macOS puts mkdtemp under /var -> /private/var and the
  // symlink resolution in resolveForCheck would otherwise look like an escape.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "btrix-paths-")));
  // A stand-in home, so the cases below do not depend on the machine running
  // the tests having (or not having) a real ~/.ssh.
  home = path.join(dir, "home");
  scope = {
    cwd: path.join(dir, "work"),
    storeRoot: path.join(dir, "work", "btrix"),
    agentDir: path.join(dir, "agent"),
    packageRoot: path.join(dir, "pkg"),
    home,
  };
  fs.mkdirSync(path.join(scope.storeRoot, "config"), { recursive: true });
  fs.mkdirSync(scope.agentDir, { recursive: true });
  fs.mkdirSync(path.join(scope.packageRoot, "skills"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("within", () => {
  it("counts the root itself", () => {
    expect(within("/a/b", "/a/b")).toBe(true);
  });

  it("does not treat a name prefix as containment", () => {
    // The bug a startsWith check would have.
    expect(within("/foo", "/foobar")).toBe(false);
    expect(within("/foo", "/foo/bar")).toBe(true);
  });

  it("rejects an escape", () => {
    expect(within("/a/b", "/a")).toBe(false);
    expect(within("/a/b", "/a/c")).toBe(false);
  });
});

describe("refuseWrite", () => {
  it("allows a config in the store", () => {
    expect(refuseWrite(scope, path.join(scope.storeRoot, "config", "wikipedia.yaml"))).toBeUndefined();
  });

  it("allows a behavior in the store", () => {
    expect(refuseWrite(scope, path.join(scope.storeRoot, "config", "behaviors", "more.js"))).toBeUndefined();
  });

  it("allows notes beside the work", () => {
    expect(refuseWrite(scope, path.join(scope.cwd, "notes.md"))).toBeUndefined();
  });

  it("resolves a relative path against cwd", () => {
    expect(refuseWrite(scope, "btrix/config/x.yaml")).toBeUndefined();
    expect(refuseWrite(scope, "../escaped.txt")).toMatch(/cannot write/);
  });

  it("refuses the agent directory, where the credential is", () => {
    expect(refuseWrite(scope, path.join(scope.agentDir, "auth.json"))).toMatch(/agent directory/);
  });

  it("refuses the agent directory even when it sits inside cwd", () => {
    const inside: Scope = { ...scope, agentDir: path.join(scope.cwd, ".btrix") };
    fs.mkdirSync(inside.agentDir, { recursive: true });
    expect(refuseWrite(inside, path.join(inside.agentDir, "auth.json"))).toMatch(/agent directory/);
  });

  it("refuses a traversal out of the store", () => {
    expect(refuseWrite(scope, path.join(scope.storeRoot, "..", "..", "escaped.txt"))).toMatch(/cannot write/);
  });

  it("refuses an absolute path elsewhere", () => {
    expect(refuseWrite(scope, "/etc/hosts")).toMatch(/cannot write/);
    expect(refuseWrite(scope, path.join(os.homedir(), ".zshrc"))).toMatch(/cannot write/);
  });

  it("refuses an empty path", () => {
    expect(refuseWrite(scope, "   ")).toBe("no path given");
  });

  it("allows a store the --dir flag put outside cwd", () => {
    const far: Scope = { ...scope, storeRoot: path.join(dir, "volume", "archive") };
    fs.mkdirSync(far.storeRoot, { recursive: true });
    expect(refuseWrite(far, path.join(far.storeRoot, "config", "x.yaml"))).toBeUndefined();
  });

  it("refuses a symlink in the store pointing out of it", () => {
    // The case a resolve-only check misses.
    const link = path.join(scope.storeRoot, "config", "out");
    fs.symlinkSync(path.join(dir, "elsewhere"), link);
    fs.mkdirSync(path.join(dir, "elsewhere"), { recursive: true });
    expect(refuseWrite(scope, path.join(link, "x.yaml"))).toMatch(/cannot write/);
  });
});

describe("refuseRead", () => {
  it("allows the directories the job happens in", () => {
    expect(refuseRead(scope, path.join(scope.cwd, "notes.md"))).toBeUndefined();
    expect(refuseRead(scope, path.join(scope.storeRoot, "runs", "x", "runner.log"))).toBeUndefined();
  });

  it("allows btrix's own files, which is where the skills keep their docs", () => {
    // skills/behaviors/SKILL.md points the model at reference/guide.md, and
    // that lives in the installed package rather than the user's directory.
    // This is the one root reads get and writes do not.
    const doc = path.join(scope.packageRoot, "skills", "behaviors", "reference", "guide.md");
    expect(refuseRead(scope, doc)).toBeUndefined();
    expect(refuseWrite(scope, doc)).toMatch(/cannot write/);
  });

  it("refuses everything else, which is what covers the credential stores", () => {
    // None of these are refused by name. They are refused because they are
    // not in a root the job uses -- so the ones nobody thought to list are
    // covered too.
    for (const p of [
      path.join(home, ".ssh", "id_rsa"),
      path.join(home, ".aws", "credentials"),
      path.join(home, ".gnupg", "secring.gpg"),
      path.join(home, ".kube", "config"),
      path.join(home, ".config", "some-tool-nobody-listed", "token"),
      path.join(home, ".zshrc"),
      "/etc/passwd",
      path.join(home, "Downloads", "seeds.txt"),
    ]) {
      expect(refuseRead(scope, p), p).toMatch(/cannot read/);
    }
  });

  it("refuses btrix's own credential directory", () => {
    expect(refuseRead(scope, path.join(scope.agentDir, "auth.json"))).toMatch(/agent directory/);
  });

  it("refuses the agent directory even when it is placed inside cwd", () => {
    // BTRIX_AGENT_DIR can do this, which is why it is subtracted rather than
    // merely being outside the roots.
    const inside: Scope = { ...scope, agentDir: path.join(scope.cwd, ".btrix") };
    fs.mkdirSync(inside.agentDir, { recursive: true });
    expect(refuseRead(inside, path.join(inside.agentDir, "auth.json"))).toMatch(/agent directory/);
  });

  it("says what to do instead, so the model does not just try another path", () => {
    expect(refuseRead(scope, "/etc/passwd")).toMatch(/copy it in or paste the contents/);
  });

  it("is not fooled by a symlink out of the store", () => {
    const link = path.join(scope.storeRoot, "shortcut");
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.symlinkSync(path.join(home, ".ssh"), link);
    expect(refuseRead(scope, path.join(link, "id_rsa"))).toMatch(/cannot read/);
  });
});

describe("resolveForCheck", () => {
  it("resolves a path that does not exist yet", () => {
    const want = path.join(scope.storeRoot, "config", "new", "deep", "x.yaml");
    expect(resolveForCheck(scope.cwd, want)).toBe(want);
  });
});

describe("refuseSearch", () => {
  // ls, grep and find replace what bash was granted for, and their path is
  // optional rather than required.
  it("allows an omitted path, which means the working directory", () => {
    expect(refuseSearch(scope, undefined)).toBeUndefined();
    expect(refuseSearch(scope, "")).toBeUndefined();
  });

  it("holds a given path to the same roots as read", () => {
    expect(refuseSearch(scope, path.join(scope.storeRoot, "runs"))).toBeUndefined();
    expect(refuseSearch(scope, path.join(scope.packageRoot, "skills"))).toBeUndefined();
    expect(refuseSearch(scope, path.join(home, ".ssh"))).toMatch(/cannot search/);
    expect(refuseSearch(scope, "/etc")).toMatch(/cannot search/);
  });
});

describe("refuseGlob", () => {
  // The pattern is expanded after the path has been checked, so a path that
  // passed can still be walked out of.
  it("refuses a pattern that climbs out", () => {
    expect(refuseGlob("../../**")).toMatch(/walks up/);
    expect(refuseGlob("../secrets/*")).toMatch(/walks up/);
    expect(refuseGlob("a/../../b")).toMatch(/walks up/);
    expect(refuseGlob("**/../../id_rsa")).toMatch(/walks up/);
  });

  it("refuses an absolute pattern", () => {
    expect(refuseGlob("/etc/**")).toMatch(/absolute path/);
  });

  it("allows the ordinary ones", () => {
    for (const ok of ["**/*.log", "*.wacz", "collections/**/*.warc.gz", "runner.log", undefined, ""]) {
      expect(refuseGlob(ok), String(ok)).toBeUndefined();
    }
  });

  it("is not fooled by a name that merely starts with dots", () => {
    // "..foo" is a filename, not a climb.
    expect(refuseGlob("..foo/*")).toBeUndefined();
    expect(refuseGlob(".env")).toBeUndefined();
  });
});

/**
 * The forms a model actually types, as opposed to the resolved paths the rest
 * of this file constructs.
 *
 * This is where the gate leaked: it resolved with `path.resolve`, which treats
 * `~` as a directory literally named "~", while pi's file tools expand it. So
 * `~/.ssh/id_rsa` was checked as `<cwd>/~/.ssh/id_rsa`, passed for being inside
 * the working directory, and was then opened as the real key. The suite missed
 * it because every case above builds the path with `path.join(home, ...)` --
 * the already-resolved form -- and never the raw string that does the damage.
 */
describe("path forms pi resolves and path.resolve does not", () => {
  it("expands ~ the way the tool will", () => {
    for (const raw of ["~/.ssh/id_rsa", "~/.zshrc", "~/mbox", "~"]) {
      expect(refuseRead(scope, raw), raw).toMatch(/cannot read/);
      expect(refuseWrite(scope, raw), raw).toMatch(/cannot write/);
      expect(refuseSearch(scope, raw), raw).toMatch(/cannot search/);
    }
  });

  it("does not let ~ reach the agent directory either", () => {
    // The credential store is the point of the whole gate, and it was reachable
    // as readily as anything else.
    const agentScope: Scope = { ...scope, agentDir: path.join(home, ".btrix") };
    expect(refuseRead(agentScope, "~/.btrix/auth.json")).toMatch(/agent directory/);
    expect(refuseWrite(agentScope, "~/.btrix/auth.json")).toMatch(/agent directory/);
  });

  it("converts file:// URLs", () => {
    expect(refuseRead(scope, `file://${path.join(home, ".ssh", "id_rsa")}`)).toMatch(/cannot read/);
    expect(refuseRead(scope, "file:///etc/passwd")).toMatch(/cannot read/);
  });

  it("strips a leading @, which pi's tools also do", () => {
    expect(refuseRead(scope, `@${path.join(home, ".ssh", "id_rsa")}`)).toMatch(/cannot read/);
    expect(refuseRead(scope, "@~/.ssh/id_rsa")).toMatch(/cannot read/);
  });

  it("folds the unicode spaces pi folds, so both resolvers name the same file", () => {
    // Fidelity, not containment: folding a space to a space cannot move a path
    // across a root boundary, so this cannot be the hole. It keeps the refusal
    // message naming the file the tool would actually have opened, which is
    // the difference between a useful refusal and a confusing one.
    const nbsp = path.join(scope.storeRoot, "config", `site\u00A0a.yaml`);
    expect(resolveForCheck(scope.cwd, nbsp, home)).toBe(
      path.join(scope.storeRoot, "config", "site a.yaml"),
    );
  });

  it("still allows these forms when they point inside a root", () => {
    // The fix must not turn the gate into a deny-list for tildes.
    const inside = path.join(scope.storeRoot, "config", "site.yaml");
    expect(refuseRead(scope, inside)).toBeUndefined();
    expect(refuseRead(scope, `file://${inside}`)).toBeUndefined();
    expect(refuseRead(scope, `@${inside}`)).toBeUndefined();
  });
});
