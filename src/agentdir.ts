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

export interface AgentDirEnv {
  BTRIX_AGENT_DIR?: string;
  PI_CODING_AGENT_DIR?: string;
  HOME?: string;
}

export function resolveAgentDir(env: AgentDirEnv = process.env, home: string = os.homedir()): string {
  const explicit = env.BTRIX_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) return path.resolve(explicit.startsWith("~") ? path.join(home, explicit.slice(1)) : explicit);
  return path.join(home, ".btrix");
}
