/**
 * Where the model is allowed to write.
 *
 * btrix hands the model pi's `write`, `edit` and `bash`, because authoring a
 * crawl config and a custom behavior is most of the job. Those tools are not
 * scoped to a directory, and pi ships no permission system, so without a gate
 * one model turn can read `~/.btrix/auth.json` or append a line to `~/.zshrc`.
 * That matters more here than in a coding agent: a crawl pulls in pages nobody
 * vetted, and their titles and URLs reach the model as text.
 *
 * Decisions here, enforcement in index.ts, so this stays testable without pi.
 *
 * This narrows the blast radius; it does not eliminate it. `bash` cannot be
 * scoped by reading the command -- see refuseWrite's note -- so index.ts puts a
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
}

/**
 * Why this write should be refused, or undefined if it is fine.
 *
 * Two permitted roots, because `btrix --dir /Volumes/archive/x` deliberately
 * puts the store outside the working directory. The agent directory is carved
 * back out even when it falls inside one of them: nothing the model writes
 * belongs next to the credential.
 */
export function refuseWrite(scope: Scope, raw: string): string | undefined {
  if (!raw.trim()) return "no path given";
  const target = resolveForCheck(scope.cwd, raw);

  if (within(scope.agentDir, target)) {
    return `${raw} is inside btrix's own agent directory (${scope.agentDir}), which holds the model credential.`;
  }
  if (within(scope.cwd, target) || within(scope.storeRoot, target)) return undefined;

  return (
    `${raw} resolves to ${target}, outside both the working directory (${scope.cwd}) ` +
    `and the btrix store (${scope.storeRoot}). Ask the user to make this edit.`
  );
}

/**
 * Reads stay open -- looking at crawler output and at files around the project
 * is ordinary work -- with one exception, because it is btrix's own secret and
 * the cost of excluding it is nil.
 */
export function refuseRead(scope: Scope, raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  if (within(scope.agentDir, resolveForCheck(scope.cwd, raw))) {
    return `${raw} is inside btrix's own agent directory (${scope.agentDir}), which holds the model credential.`;
  }
  return undefined;
}
