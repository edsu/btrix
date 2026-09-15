/**
 * The write scope. This is the gate standing between an injected page title
 * and the model credential, so the interesting cases are all the ways a path
 * can look inside the store without being inside it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refuseRead, refuseWrite, resolveForCheck, type Scope, within } from "../src/paths.ts";

let dir: string;
let scope: Scope;

beforeEach(() => {
  // realpath, because macOS puts mkdtemp under /var -> /private/var and the
  // symlink resolution in resolveForCheck would otherwise look like an escape.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "btrix-paths-")));
  scope = {
    cwd: path.join(dir, "work"),
    storeRoot: path.join(dir, "work", "btrix"),
    agentDir: path.join(dir, "agent"),
  };
  fs.mkdirSync(path.join(scope.storeRoot, "config"), { recursive: true });
  fs.mkdirSync(scope.agentDir, { recursive: true });
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
    expect(refuseWrite(scope, "../escaped.txt")).toMatch(/outside both/);
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
    expect(refuseWrite(scope, path.join(scope.storeRoot, "..", "..", "escaped.txt"))).toMatch(/outside both/);
  });

  it("refuses an absolute path elsewhere", () => {
    expect(refuseWrite(scope, "/etc/hosts")).toMatch(/outside both/);
    expect(refuseWrite(scope, path.join(os.homedir(), ".zshrc"))).toMatch(/outside both/);
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
    expect(refuseWrite(scope, path.join(link, "x.yaml"))).toMatch(/outside both/);
  });
});

describe("refuseRead", () => {
  it("leaves ordinary reads alone", () => {
    expect(refuseRead(scope, "/etc/hosts")).toBeUndefined();
    expect(refuseRead(scope, path.join(scope.storeRoot, "runs", "x", "runner.log"))).toBeUndefined();
  });

  it("refuses the credential", () => {
    expect(refuseRead(scope, path.join(scope.agentDir, "auth.json"))).toMatch(/agent directory/);
  });
});

describe("resolveForCheck", () => {
  it("resolves a path that does not exist yet", () => {
    const want = path.join(scope.storeRoot, "config", "new", "deep", "x.yaml");
    expect(resolveForCheck(scope.cwd, want)).toBe(want);
  });
});
