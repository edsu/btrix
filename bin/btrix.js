#!/usr/bin/env node
/**
 * btrix — a launcher, so that installing and running this needs no knowledge of
 * pi.
 *
 * It starts a pi session with the btrix extension preloaded, a btrix system
 * prompt, and only the tools this job needs — read from src/toolnames.ts, so
 * the list cannot drift behind the tools that actually exist.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

// Read from the same list the tools are registered from, so the allowlist
// cannot drift out of date the way it did.
const { ALL_TOOLS } = await import(path.join(PKG, "src", "toolnames.ts"));
const TOOLS = ALL_TOOLS.join(",");

const { resolveAgentDir } = await import(path.join(PKG, "src", "agentdir.ts"));
const AGENT_DIR = resolveAgentDir();

/**
 * Prefer the pi we were installed with, so a btrix release is pinned to a pi it
 * was tested against, and fall back to one on PATH for a working-tree checkout.
 */
function findPi() {
  const require = createRequire(import.meta.url);
  try {
    const manifest = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const dir = path.dirname(manifest);
    const bin = JSON.parse(fs.readFileSync(manifest, "utf8")).bin;
    const rel = typeof bin === "string" ? bin : bin?.pi;
    if (rel) {
      const entry = path.join(dir, rel);
      if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] };
    }
  } catch {
    // Not installed as a dependency; a checkout run with `npm link` lands here.
  }
  return { command: "pi", prefix: [] };
}

/**
 * Quiet the harness's startup listing — the skills, extensions and resource
 * inventory it prints, which means nothing to someone who installed a web
 * archiving tool.
 *
 * Only when no settings file exists yet, so an edited one is never rewritten.
 * Since btrix has its own agent directory, this is its own preference to set
 * and not a change to anybody's pi configuration.
 */
function quietFirstRun() {
  try {
    const file = path.join(AGENT_DIR, "settings.json");
    if (fs.existsSync(file)) return;
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ quietStartup: true }, null, 2)}\n`);
  } catch {
    // A noisier startup is not worth failing to start over.
  }
}

quietFirstRun();

const systemPrompt = fs.readFileSync(path.join(PKG, "assets", "system-prompt.md"), "utf8");
const { command, prefix } = findPi();

const args = [
  ...prefix,
  "--extension",
  PKG,
  "--system-prompt",
  systemPrompt,
  "--tools",
  TOOLS,
  ...process.argv.slice(2),
];

const child = spawn(command, args, {
  stdio: "inherit",
  // Keep credentials, preferences and history under btrix's own directory.
  env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
});

child.on("error", (err) => {
  if (err.code === "ENOENT" && command === "pi") {
    process.stderr.write(
      "btrix could not find its agent runtime.\n" +
        "If you are running from a checkout, install it with:\n\n" +
        "  npm install -g @earendil-works/pi-coding-agent\n\n",
    );
    process.exit(127);
  }
  process.stderr.write(`btrix failed to start: ${err.message}\n`);
  process.exit(1);
});

// Signals reach the child through the shared terminal; just mirror its exit so
// scripts calling btrix see the real status.
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
