#!/usr/bin/env node
/**
 * btrix — a launcher, so that installing and running this needs no knowledge of
 * pi.
 *
 * It starts a pi session with the btrix extension preloaded, a btrix system
 * prompt, and only the tools this job needs — read from src/toolnames.js, so
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
const { ALL_TOOLS } = await import(path.join(PKG, "src", "toolnames.js"));
const TOOLS = ALL_TOOLS.join(",");

const { resolveAgentDir } = await import(path.join(PKG, "src", "agentdir.js"));
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
/**
 * The agent directory holds the model credential (auth.json), any provider
 * keys written into models.json, and every session transcript. Created at the
 * default umask it comes out 0755, so any other account on the machine can
 * traverse it and read whatever pi did not individually chmod -- models.json
 * is written 0644.
 *
 * This has to run before pi does: pi's own mkdirSync is `recursive: true`,
 * which is a no-op on an existing directory and so cannot tighten the mode
 * afterwards. The chmod covers installs that already have a loose directory,
 * since mkdir will not touch one that exists.
 */
function secureAgentDir() {
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
    if ((fs.statSync(AGENT_DIR).mode & 0o077) !== 0) fs.chmodSync(AGENT_DIR, 0o700);
  } catch {
    // Not worth failing to start over; pi will report a real problem here.
  }
}

function quietFirstRun() {
  try {
    const file = path.join(AGENT_DIR, "settings.json");
    if (fs.existsSync(file)) return;
    fs.mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ quietStartup: true }, null, 2)}\n`);
  } catch {
    // A noisier startup is not worth failing to start over.
  }
}

secureAgentDir();
quietFirstRun();

/**
 * Answer --help and --version here rather than letting them through.
 *
 * pi answers them as itself: its usage says `pi`, it documents flags btrix
 * does not use, and it advertises "read, bash, edit, write tools" -- bash
 * being one btrix deliberately does not grant. Someone who installed a web
 * archiving tool and typed --help should not have to work out what pi is.
 *
 * Only these two. Every other flag still passes through, because pi's
 * --session, -c, -r, --model and -p are all useful here and reimplementing
 * them would be worse than forwarding them.
 */
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const HELP = `btrix ${version()} — high-fidelity web archives, by conversation

Describe what you want archived. btrix settles the scope with you, writes the
crawl config, runs Browsertrix Crawler in a container, and hands you a WACZ.

usage
  btrix [options]

  Then talk to it: "archive the news section of example.org", "crawl example",
  "did that crawl work?", "replay example".

options
  --dir <path>        the btrix store (default: ./btrix)
  -c, --continue      resume the last session in this directory
  -r, --resume        pick a session to resume
  --session <id>      resume a particular session
  --model <pattern>   choose a model for this session
  -p, --print         run one prompt without the interactive UI
  -h, --help          this
  -V, --version       print the version

  Other options are passed through to the agent runtime underneath.

environment
  BTRIX_DIR                the store, same as --dir
  BTRIX_AGENT_DIR          where the model credential, preferences and session
                           history live (default: ~/.btrix, mode 0700)
  BTRIX_CRAWLER_VERSION    browsertrix-crawler image tag (default: latest)
  BTRIX_CHROME             path to Chrome for the scratch browser
  BTRIX_ENGINE             container engine to use (podman, docker), or
                           "none" to skip detection entirely

first run
  Type /login to connect a Claude, ChatGPT or Copilot subscription, or set an
  API key such as ANTHROPIC_API_KEY. Crawling itself needs no account.

  Crawls are detached: quitting does not stop one, and btrix picks it back up.

  Browsertrix Crawler and the WACZ format are the work of Webrecorder.
  https://github.com/edsu/btrix
`;

const flags = process.argv.slice(2);
if (flags.includes("--help") || flags.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (flags.includes("--version") || flags.includes("-V")) {
  process.stdout.write(`btrix ${version()}\n`);
  process.exit(0);
}

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
