/**
 * Where btrix keeps the state that is not part of a crawl store: the model
 * credential, its own startup preferences, and session history.
 *
 * `~/.btrix`, not the harness's `~/.pi/agent`. Someone who installed btrix and
 * has never heard of pi should not find their credentials filed under it — and
 * owning the directory means btrix can set its own startup preferences without
 * touching those of anyone who does use pi directly.
 *
 * The cost is that a login is not shared between the two. Setting
 * `BTRIX_AGENT_DIR` (or `PI_CODING_AGENT_DIR`) to `~/.pi/agent` shares it for
 * anyone who would rather.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Plain JavaScript, not TypeScript, and deliberately so: bin/btrix.js has to
 * read this before pi starts, and Node refuses to strip types for files under
 * node_modules. As .ts this worked from a linked working tree -- where the
 * symlink resolves outside node_modules -- and broke on every real install.
 * Type-checked all the same, via checkJs.
 *
 * @typedef {{ BTRIX_AGENT_DIR?: string, PI_CODING_AGENT_DIR?: string, HOME?: string }} AgentDirEnv
 */

/**
 * @param {AgentDirEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveAgentDir(env = process.env, home = os.homedir()) {
  const explicit = env.BTRIX_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) return path.resolve(explicit.startsWith("~") ? path.join(home, explicit.slice(1)) : explicit);
  return path.join(home, ".btrix");
}
