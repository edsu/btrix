/**
 * The read and write scope. This is the gate standing between an injected page
 * title and the user's credentials, so the interesting cases are all the ways a
 * path can look like it is inside the store without being inside it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeRead, refuseWrite, resolveForCheck, type Scope, within } from "../src/paths.ts";

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
    packageRoot: path.join(dir, "pkg"),
    // A fake home, so the credential-store cases do not depend on the
    // machine running the tests having (or not having) a real ~/.ssh.
    home: path.join(dir, "home"),
  };
  fs.mkdirSync(path.join(scope.storeRoot, "config"), { recursive: true });
  fs.mkdirSync(scope.agentDir, { recursive: true });
  fs.mkdirSync(path.join(scope.packageRoot, "skills"), { recursive: true });
  fs.mkdirSync(scope.home, { recursive: true });
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

describe("judgeRead", () => {
  const kind = (raw: string) => judgeRead(scope, raw).kind;

  it("allows the directories the job happens in", () => {
    expect(kind(path.join(scope.cwd, "notes.md"))).toBe("allow");
    expect(kind(path.join(scope.storeRoot, "runs", "x", "runner.log"))).toBe("allow");
  });

  it("allows btrix's own files, which is where the skills keep their docs", () => {
    // skills/behaviors/SKILL.md points the model at reference/guide.md, and
    // that lives in the installed package rather than the user's directory.
    expect(kind(path.join(scope.packageRoot, "skills", "behaviors", "reference", "guide.md"))).toBe("allow");
  });

  it("never reads a credential store, not even to ask", () => {
    for (const p of [
      path.join(scope.home, ".ssh", "id_rsa"),
      path.join(scope.home, ".ssh", "config"),
      path.join(scope.home, ".aws", "credentials"),
      path.join(scope.home, ".gnupg", "secring.gpg"),
      path.join(scope.home, ".kube", "config"),
      path.join(scope.home, ".docker", "config.json"),
      path.join(scope.home, ".config", "gh", "hosts.yml"),
      path.join(scope.home, "Library", "Keychains", "login.keychain-db"),
    ]) {
      expect(kind(p), p).toBe("deny");
    }
  });

  it("refuses credential filenames wherever they turn up, including in cwd", () => {
    // A .env or an id_ed25519 sitting in the project is still a secret, and
    // btrix has no use for either.
    expect(kind(path.join(scope.cwd, ".env"))).toBe("deny");
    expect(kind(path.join(scope.cwd, ".env.production"))).toBe("deny");
    expect(kind(path.join(scope.cwd, ".netrc"))).toBe("deny");
    expect(kind(path.join(scope.storeRoot, "id_ed25519"))).toBe("deny");
  });

  it("refuses btrix's own credential directory", () => {
    expect(kind(path.join(scope.agentDir, "auth.json"))).toBe("deny");
  });

  it("asks about anything else, rather than allowing or breaking it", () => {
    // Reading a seed list out of ~/Downloads is a real thing to want; it is
    // just not something to do without saying so.
    expect(kind(path.join(scope.home, "Downloads", "seeds.txt"))).toBe("ask");
    expect(kind("/etc/hosts")).toBe("ask");
  });

  it("carries a reason on every refusal and question", () => {
    for (const raw of [path.join(scope.home, ".ssh", "id_rsa"), "/etc/hosts"]) {
      const v = judgeRead(scope, raw);
      expect(v.kind === "allow" ? "" : v.reason).toBeTruthy();
    }
  });

  it("is not fooled by a symlink out of the store", () => {
    const link = path.join(scope.storeRoot, "shortcut");
    fs.mkdirSync(path.join(scope.home, ".ssh"), { recursive: true });
    fs.symlinkSync(path.join(scope.home, ".ssh"), link);
    expect(kind(path.join(link, "id_rsa"))).toBe("deny");
  });
});

describe("resolveForCheck", () => {
  it("resolves a path that does not exist yet", () => {
    const want = path.join(scope.storeRoot, "config", "new", "deep", "x.yaml");
    expect(resolveForCheck(scope.cwd, want)).toBe(want);
  });
});
