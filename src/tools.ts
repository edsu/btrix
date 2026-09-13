/**
 * The tools the model calls.
 *
 * These replace SKILL.md files that told the model to run a shell script "bare
 * — exactly as written, with no pipe, redirect, `;`, `&&`, or command
 * substitution attached". That instruction existed to satisfy a permission
 * hook; a registered tool has a schema instead, so there is no wrapper to
 * mis-invoke and no prompt to dodge.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isCrawlRunning, killCrawl, runningCrawls } from "./engine.ts";
import type { CrawlMonitor, WatchTarget } from "./monitor.ts";
import { renderForModel } from "./render.ts";
import { activeRun, collectionFor, ensureStore, prepareRun, type Store } from "./store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_SH = path.join(HERE, "..", "scripts", "run.sh");

/** How long to wait for the image pull and first log output before returning. */
const STARTUP_TIMEOUT_MS = 180_000;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** Accept "sulnews", "sulnews.yaml" or "sulnews.yml" alike. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\.ya?ml$/, "");
}

export function configPath(store: Store, name: string): string | undefined {
  for (const ext of [".yaml", ".yml"]) {
    const p = path.join(store.configDir, `${name}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export function listConfigs(store: Store): string[] {
  try {
    return fs
      .readdirSync(store.configDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Locate a crawl by the name the user said, which may be a config name, a
 * collection name, or a legacy top-level collection.
 */
export function resolveTarget(store: Store, monitor: CrawlMonitor, name: string, legacy?: string): WatchTarget | undefined {
  const config = normalizeName(name);

  const file = configPath(store, config);
  if (file) {
    const collection = collectionFor(file, config);
    const root = activeRun(store, config, collection);
    if (root) return { config, collection, root };
  }

  // Already being watched, including adopted and legacy crawls.
  const watched = monitor.watched().find((t) => t.config === config || t.collection === config);
  if (watched) return watched;

  // A finished run in the store, newest first.
  if (file) {
    const collection = collectionFor(file, config);
    for (const run of runsWith(store, config, collection)) return { config, collection, root: run };
  }

  // Legacy or hand-run layout: ./collections/<name>
  if (legacy && fs.existsSync(path.join(legacy, "collections", config))) {
    return { config, collection: config, root: legacy };
  }
  return undefined;
}

function runsWith(store: Store, config: string, collection: string): string[] {
  try {
    return fs
      .readdirSync(store.runsDir)
      .filter((d) => d.startsWith(`${config}-`))
      .sort()
      .reverse()
      .map((d) => path.join(store.runsDir, d))
      .filter((r) => fs.existsSync(path.join(r, "collections", collection)));
  } catch {
    return [];
  }
}

/**
 * The store is passed as an accessor, not a value: `--dir` is not parsed until
 * session_start, well after the factory registers these tools, so capturing a
 * Store object here would silently ignore the flag.
 */
export function createTools(
  monitor: CrawlMonitor,
  getStore: () => Store,
  getLegacy: () => string | undefined = () => undefined,
): ToolDefinition<any, any, any>[] {
  const runTool = defineTool({
    name: "btrix_run",
    label: "Crawl",
    description:
      "Start a Browsertrix Crawler crawl for a config in the btrix store. Returns once the crawler is up and " +
      "reporting; the crawl itself keeps running in the background, detached, and survives this session. " +
      "Progress is shown continuously in the TUI widget, so do not poll for it.",
    promptSnippet: "Start a Browsertrix crawl for a named config",
    parameters: Type.Object({
      config: Type.String({ description: "Config name in the store's config/ directory, without the .yaml extension" }),
    }),
    async execute(_id, params, signal, onUpdate) {
      const store = getStore();
      const config = normalizeName(String(params.config));
      ensureStore(store);

      const file = configPath(store, config);
      if (!file) {
        const available = listConfigs(store);
        return text(
          `No ${config}.yaml in ${store.configDir}.` +
            (available.length ? ` Available configs: ${available.join(", ")}` : " There are no configs yet."),
        );
      }

      // The collection directory is named by the config's `collection:` key,
      // which need not match the config's filename.
      const collection = collectionFor(file, config);

      if (await isCrawlRunning(config)) {
        const running = activeRun(store, config, collection);
        if (running) monitor.watch({ config, collection, root: running });
        return text(`A crawl for ${config} is already running. Its progress is in the widget.`);
      }

      // Each attempt gets its own run directory, mounted at /crawls, with a
      // copy of the config that produced it.
      const runDir = prepareRun(store, config, new Date());
      const target: WatchTarget = { config, collection, root: runDir };

      const logPath = path.join(runDir, "runner.log");
      const out = fs.openSync(logPath, "a");
      const child = spawn("bash", [RUN_SH, config, runDir], {
        cwd: store.root,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      fs.closeSync(out);
      monitor.watch(target);

      let exited: number | null | undefined;
      child.on("exit", (code) => {
        exited = code;
      });

      // Wait out the image pull and the first statistics line. This window is
      // what the tool's AbortSignal cancels; after it, the crawl is on its own.
      onUpdate?.({ content: [{ type: "text", text: `pulling image and starting ${config}…` }], details: {} });
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let announcedContainer = false;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await killCrawl(config);
          return text(`Cancelled; stopped the ${config} crawl. Partial output is in ${runDir}.`);
        }
        const stats = await monitor.stats(target);
        if (stats.crawled > 0 || stats.total > 0) {
          return {
            content: [{ type: "text", text: `Started ${config}. ${renderForModel(stats)}` }],
            details: stats,
          };
        }
        if (stats.containerRunning && !announcedContainer) {
          announcedContainer = true;
          onUpdate?.({ content: [{ type: "text", text: "container up, waiting for first statistics…" }], details: {} });
        }
        if (exited !== undefined && exited !== 0 && !stats.containerRunning) {
          const tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-12).join("\n");
          return text(`The runner exited with code ${exited} before crawling started:\n\n${tail}`);
        }
        await sleep(1_500);
      }

      const stats = await monitor.stats(target);
      return {
        content: [
          {
            type: "text",
            text:
              `Started ${config}, but it has not reported statistics within ` +
              `${Math.round(STARTUP_TIMEOUT_MS / 1000)}s. ${renderForModel(stats)}\nRunner output: ${logPath}`,
          },
        ],
        details: stats,
      };
    },
  });

  const statusTool = defineTool({
    name: "btrix_status",
    label: "Crawl status",
    description:
      "Read the current state of a crawl: pages, rates, sizes, free space, failures. Use this to answer a " +
      "question or diagnose a problem — not to watch progress, which the TUI widget already shows.",
    promptSnippet: "Read the state of a Browsertrix crawl",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Config or collection name. Defaults to the only running or watched crawl." }),
      ),
    }),
    async execute(_id, params) {
      const store = getStore();
      const legacy = getLegacy();
      let name = params.name ? String(params.name) : undefined;

      if (!name) {
        const running = (await runningCrawls()).map((c) => c.config).filter((n): n is string => !!n);
        const candidates = running.length ? running : monitor.watched().map((t) => t.config);
        const unique = [...new Set(candidates)];
        if (unique.length === 1) name = unique[0];
        else if (unique.length > 1) {
          return text(`Several crawls to choose from: ${unique.join(", ")}. Ask for one by name.`);
        } else {
          return text("No crawl is running and none is being watched. Name a config or collection explicitly.");
        }
      }

      const target = resolveTarget(store, monitor, name!, legacy);
      if (!target) {
        const configs = listConfigs(store);
        return text(
          `Nothing crawled for ${normalizeName(name!)} yet.` +
            (configs.includes(normalizeName(name!)) ? " The config exists — start it with btrix_run." : "") +
            (configs.length ? ` Configs in the store: ${configs.join(", ")}` : ""),
        );
      }

      const stats = await monitor.stats(target);
      monitor.watch(target);
      return { content: [{ type: "text", text: renderForModel(stats) }], details: stats };
    },
  });

  return [runTool, statusTool];
}
