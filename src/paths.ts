/**
 * Where the model is allowed to read and write.
 *
 * btrix hands the model pi's `read`, `write`, `edit` and `bash`, because
 * authoring a crawl config and a custom behavior is most of the job. Those
 * tools are not scoped to a directory, and pi ships no permission system, so
 * without a gate one model turn can read `~/.btrix/auth.json` or `~/.ssh/id_rsa`
 * or append a line to `~/.zshrc`. That matters more here than in a coding
 * agent: a crawl pulls in pages nobody vetted, and their titles and URLs reach
 * the model as text.
 *
 * Decisions here, enforcement in index.ts, so this stays testable without pi.
 *
 * Both tools share one boundary, and it is default deny: a path is inside a
 * root the job actually uses, or it is refused. `bash` is the exception, since
 * it cannot be scoped by reading the command -- see index.ts, which puts a
 * person in front of it instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Whether `target` is `root` itself or sits underneath it. */
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  // "" is root itself, which counts. A leading ".." escapes it. An absolute
  // result means there is no path between them at all. Comparing the strings
  // directly would be wrong: "/foo" is a prefix of "/foobar".
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Resolve a model-supplied path the way the tool will, then follow symlinks.
 *
 * Without the symlink step a link planted inside the store points anywhere and
 * a containment check still says yes. The target itself usually does not exist
 * -- that is the normal case for a write -- so fall back to resolving the
 * nearest ancestor that does and re-attaching the remainder.
 */
export function resolveForCheck(cwd: string, raw: string): string {
  const abs = path.resolve(cwd, raw);
  try {
    return fs.realpathSync(abs);
  } catch {
    let dir = path.dirname(abs);
    for (;;) {
      try {
        return path.join(fs.realpathSync(dir), path.relative(dir, abs));
      } catch {
        const up = path.dirname(dir);
        if (up === dir) return abs;
        dir = up;
      }
    }
  }
}

export interface Scope {
  /** Where btrix was started. Configs and notes live here. */
  cwd: string;
  /** The store root, which `--dir` can put outside cwd on purpose. */
  storeRoot: string;
  /** btrix's own agent directory, which holds the model credential. */
  agentDir: string;
  /**
   * The installed package. Readable, not writable: the skills point the model
   * at `reference/guide.md` and `assets/config-template.yaml`, which live here
   * rather than in the user's directory.
   */
  packageRoot: string;
}

/**
 * Writes land in the working directory or the store. Nowhere else.
 */
function writeRoots(scope: Scope): string[] {
  return [scope.cwd, scope.storeRoot];
}

/**
 * Reads reach those plus btrix's own installed files, so the skills can read
 * their own reference docs.
 */
function readRoots(scope: Scope): string[] {
  return [scope.cwd, scope.storeRoot, scope.packageRoot];
}

/**
 * The one boundary, for both tools: inside a listed root, or refused.
 *
 * Default deny rather than a list of forbidden places. A deny-list only covers
 * what someone thought of -- ~/.ssh and ~/.aws are easy to name, ~/.config for
 * some tool nobody here has heard of is not -- and it has to be maintained
 * forever. This way the unknown cases are handled by not being listed, which
 * is the direction that fails safe.
 *
 * The agent directory is subtracted even though it is normally outside all of
 * these, because BTRIX_AGENT_DIR can put it inside one.
 */
function refuse(scope: Scope, raw: string, roots: string[], verb: string): string | undefined {
  if (!raw.trim()) return "no path given";
  const target = resolveForCheck(scope.cwd, raw);

  if (within(scope.agentDir, target)) {
    return `${raw} is inside btrix's own agent directory (${scope.agentDir}), which holds the model credential.`;
  }
  if (roots.some((root) => within(root, target))) return undefined;

  return (
    `${raw} resolves to ${target}, which btrix cannot ${verb}: it is outside the working directory ` +
    `(${scope.cwd}) and the btrix store (${scope.storeRoot}). If the user wants it used, ask them to ` +
    `copy it in or paste the contents.`
  );
}

/** Why this write should be refused, or undefined if it is fine. */
export function refuseWrite(scope: Scope, raw: string): string | undefined {
  return refuse(scope, raw, writeRoots(scope), "write");
}

/** Why this read should be refused, or undefined if it is fine. */
export function refuseRead(scope: Scope, raw: string): string | undefined {
  return refuse(scope, raw, readRoots(scope), "read");
}

/**
 * The same boundary for `ls`, `grep` and `find`, whose path is optional --
 * omitted means the working directory, which is allowed.
 */
export function refuseSearch(scope: Scope, raw: string | undefined): string | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  return refuse(scope, raw, readRoots(scope), "search");
}

/**
 * `grep` takes a glob and `find` takes a glob pattern, and both are expanded
 * after the path check has already happened -- so `../../**` would walk out of
 * a directory that passed. A `..` segment has no legitimate use in either here,
 * so it is refused rather than resolved.
 */
export function refuseGlob(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(/[\\/]/);
  if (parts.includes("..")) {
    return `The pattern ${raw} walks up out of the directory being searched, which btrix does not allow.`;
  }
  if (path.isAbsolute(raw)) {
    return `The pattern ${raw} is an absolute path; give a path plus a relative pattern instead.`;
  }
  return undefined;
}
