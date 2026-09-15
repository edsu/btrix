/**
 * Where the model is allowed to read and write.
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
 * scoped by reading the command -- see index.ts -- so a person is put in front
 * of it instead. Writes get a yes or no; reads get three tiers, because the
 * places a read legitimately goes are too broad for a single boundary.
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
   * The installed package. Reads only: the skills point the model at
   * `reference/guide.md` and `assets/config-template.yaml`, which live here
   * rather than in the user's directory, so a cwd-only read scope would break
   * the behaviors and new-crawl skills.
   */
  packageRoot: string;
  /** Home, for locating the credential stores below. Split out for tests. */
  home: string;
}

/**
 * Credential stores, relative to home. A web archiving tool has no business in
 * any of them, so these are refused outright rather than offered as a
 * question -- a prompt the user sees often enough becomes a prompt they click
 * through, and these are the ones not to get wrong.
 *
 * A deny-list cannot be complete, which is why it is the third tier and not
 * the first: anything outside the allowed roots already has to be confirmed.
 * This list only decides what cannot be confirmed at all.
 */
const CREDENTIAL_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".docker",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".local/share/keyrings",
  "Library/Keychains",
];

/** Filenames that are a credential wherever they turn up, including in cwd. */
const CREDENTIAL_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
];

function isCredentialPath(scope: Scope, target: string): boolean {
  if (CREDENTIAL_DIRS.some((d) => within(path.join(scope.home, ...d.split("/")), target))) return true;
  const base = path.basename(target);
  if (CREDENTIAL_FILES.includes(base)) return true;
  // .env, .env.local, .env.production — secrets by convention, and nothing
  // btrix does needs one.
  return base === ".env" || base.startsWith(".env.");
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

export type ReadVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

/**
 * What to do with a read.
 *
 * Writes get a straight yes or no, because the places a write belongs are
 * few and known. Reads are broader -- crawler output, files around the
 * project, the skills' own reference docs -- so a hard scope would either
 * break real work or be so wide as to mean nothing. Three tiers instead:
 * allowed where the job happens, refused outright for credential stores, and
 * a question for everything else.
 */
export function judgeRead(scope: Scope, raw: string): ReadVerdict {
  if (!raw.trim()) return { kind: "allow" };
  const target = resolveForCheck(scope.cwd, raw);

  if (within(scope.agentDir, target)) {
    return {
      kind: "deny",
      reason: `${raw} is inside btrix's own agent directory (${scope.agentDir}), which holds the model credential.`,
    };
  }
  if (isCredentialPath(scope, target)) {
    return { kind: "deny", reason: `${raw} is a credential store, which btrix will not read.` };
  }
  if (
    within(scope.cwd, target) ||
    within(scope.storeRoot, target) ||
    within(scope.packageRoot, target)
  ) {
    return { kind: "allow" };
  }
  return {
    kind: "ask",
    reason: `${raw} resolves to ${target}, outside the working directory, the btrix store and btrix's own files.`,
  };
}
