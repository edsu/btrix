/**
 * The tool names, in one place.
 *
 * The launcher restricts which tools a session may use, and that list was
 * written once and then drifted as tools were added — six of them ended up
 * unreachable through the `btrix` command while working fine under `pi -e`.
 * Both the launcher and a test read this, so adding a tool without listing it
 * here fails the suite rather than going quietly missing.
 *
 * Deliberately free of imports, so the launcher can read it without pulling in
 * the rest of the codebase -- and plain JavaScript, because Node refuses to
 * strip types for files under node_modules, so as .ts this ran from a linked
 * working tree and broke on every real install. Type-checked via checkJs.
 *
 * No `as const` here, because that is TypeScript syntax and Node would not
 * parse it. The lists are plain string arrays; the test below asserts their
 * contents rather than leaning on the type.
 */

export const BTRIX_TOOLS = [
  "btrix_run",
  "btrix_stop",
  "btrix_status",
  "btrix_list",
  "btrix_review",
  "btrix_view",
  "btrix_profile",
  "btrix_clean",
  "btrix_browser",
  "btrix_eval",
];

/**
 * Built-ins the job needs. `read` must stay: pi only advertises skills in the
 * system prompt when `read` or `bash` is available, and `bash` is deliberately
 * not granted.
 *
 * No `bash`, and no `powershell`. Every tool listed here takes a path, which
 * means index.ts can hold all of them to the same boundary -- the working
 * directory, the store, and btrix's own files for reads. A shell cannot be
 * held to anything: `$HOME`, subshells and `eval` defeat any inspection of the
 * command, so granting it would have made the path gate advisory. `ls`, `grep`
 * and `find` cover what bash was actually here for, which was looking at
 * crawler output.
 *
 * This is the model's toolset, not the user's. pi's `!` prefix is a separate
 * path and still runs whatever the user types.
 */
export const HELPER_TOOLS = ["read", "write", "edit", "ls", "grep", "find"];

export const ALL_TOOLS = [...BTRIX_TOOLS, ...HELPER_TOOLS];
