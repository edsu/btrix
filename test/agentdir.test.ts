/**
 * Where btrix keeps its credential and preferences.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDir } from "../src/agentdir.ts";

const HOME = "/home/someone";

describe("resolveAgentDir", () => {
  it("defaults to ~/.btrix, not the harness's directory", () => {
    // Someone who installed btrix should not find their credential filed under
    // a tool they have never heard of.
    expect(resolveAgentDir({}, HOME)).toBe(path.join(HOME, ".btrix"));
  });

  it("can be pointed elsewhere, including at pi's own directory to share a login", () => {
    expect(resolveAgentDir({ BTRIX_AGENT_DIR: "/tmp/elsewhere" }, HOME)).toBe("/tmp/elsewhere");
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/pi" }, HOME)).toBe("/tmp/pi");
    expect(resolveAgentDir({ BTRIX_AGENT_DIR: "~/.pi/agent" }, HOME)).toBe(path.join(HOME, ".pi", "agent"));
  });

  it("prefers its own variable over the harness's", () => {
    expect(resolveAgentDir({ BTRIX_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/b" }, HOME)).toBe("/a");
  });

  it("ignores blank values rather than resolving to nothing", () => {
    expect(resolveAgentDir({ BTRIX_AGENT_DIR: "   " }, HOME)).toBe(path.join(HOME, ".btrix"));
  });
});
