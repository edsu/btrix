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
 * the rest of the codebase.
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
] as const;

/**
 * Built-ins the job needs. `read` or `bash` must stay: pi only advertises
 * skills in the system prompt when one of them is available, so dropping both
 * would silently hide the behaviors and replay skills.
 */
export const HELPER_TOOLS = ["read", "write", "edit", "bash"] as const;

export const ALL_TOOLS = [...BTRIX_TOOLS, ...HELPER_TOOLS];
