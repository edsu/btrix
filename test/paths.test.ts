/**
 * The read and write scope. This is the gate standing between an injected page
 * title and the user's credentials, so the interesting cases are all the ways a
 * path can look like it is inside the store without being inside it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refuseRead, refuseWrite, resolveForCheck, type Scope, within } from "../src/paths.ts";

let dir: string;
let scope: Scope;
let home: string;

beforeEach(() => {
  // realpath, because macOS puts mkdtemp under /var -> /private/var and the
  // symlink resolution in resolveForCheck would otherwise look like an escape.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "btrix-paths-")));
  scope = {
    cwd: path.join(dir, "work"),
    storeRoot: path.join(dir, "work", "btrix"),
    agentDir: path.join(dir, "agent"),
    packageRoot: path.join(dir, "pkg"),
  };
  fs.mkdirSync(path.join(scope.storeRoot, "config"), { recursive: true });
  fs.mkdirSync(scope.agentDir, { recursive: true });
  fs.mkdirSync(path.join(scope.packageRoot, "skills"), { recursive: true });
  // A stand-in home, so the cases below do not depend on the machine running
  // the tests having (or not having) a real ~/.ssh.
  home = path.join(dir, "home");
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
