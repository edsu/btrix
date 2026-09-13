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
import { buildInventory } from "./inventory.ts";
import type { CrawlMonitor, WatchTarget } from "./monitor.ts";
import { analyzePages, type PagesReport, readPages } from "./pages.ts";
import { inventoryForModel, isLive, renderForModel, reviewForModel } from "./render.ts";
import type { ReplayServers } from "./serve.ts";
import { humanBytes } from "./sizes.ts";
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
  servers?: ReplayServers,
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

  const listTool = defineTool({
    name: "btrix_list",
    label: "Inventory",
    description:
      "List what is in the btrix store: configs, runs and their state, finished archives, profiles, failed runs " +
      "and free space. Use it to find a name you were not given, or to answer what the user has.",
    promptSnippet: "List btrix configs, crawls and archives",
    parameters: Type.Object({}),
    async execute() {
      const inv = await buildInventory(getStore(), getLegacy());
      return { content: [{ type: "text", text: inventoryForModel(inv) }], details: inv };
    },
  });

  const viewTool = defineTool({
    name: "btrix_view",
    label: "Replay",
    description:
      "Serve a finished archive locally and return a ReplayWeb.page URL for it. The server keeps running until " +
      "the session ends. Relay the Chrome local-network caveat in the result to the user before they open the link.",
    promptSnippet: "Replay a finished crawl in ReplayWeb.page",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Collection or config name. Defaults to the only archive." })),
    }),
    async execute(_id, params) {
      if (!servers) return text("Replay is unavailable: no server manager was wired up.");
      const store = getStore();
      const inv = await buildInventory(store, getLegacy());

      if (!inv.archives.length) {
        const inProgress = inv.runs.filter((r) => r.stats.state !== "done" && r.stats.state !== "stopped");
        if (inProgress.length) {
          return text(
            `No finished archive yet — ${inProgress.map((r) => r.config).join(", ")} ${inProgress.length === 1 ? "is" : "are"} still running.`,
          );
        }
        const noWacz = inv.configs.filter((c) => !c.generateWacz).map((c) => c.name);
        return text(
          "There are no archives in the store yet." +
            (noWacz.length ? ` Note that ${noWacz.join(", ")} ${noWacz.length === 1 ? "has" : "have"} generateWACZ off, so no wacz will be produced.` : ""),
        );
      }

      const asked = params.name ? normalizeName(String(params.name)) : undefined;
      const archive = asked
        ? // Accept either the collection name or the config name that produced it.
          inv.archives.find((a) => a.collection === asked) ??
          inv.archives.find((a) => a.provenance?.config === `${asked}.yaml`) ??
          inv.archives.find((a) => inv.configs.some((c) => c.name === asked && c.collection === a.collection))
        : inv.archives.length === 1
          ? inv.archives[0]
          : undefined;

      if (!archive) {
        const names = inv.archives.map((a) => a.collection).join(", ");
        return text(asked ? `No archive called ${asked}. Available: ${names}` : `Several archives: ${names}. Ask for one by name.`);
      }

      if (archive.kind === "warc-dir") {
        return text(
          `${archive.collection} was crawled with generateWACZ off, so there is no wacz to replay — only WARCs at ` +
            `${archive.path}. Re-crawl with generateWACZ: true to replay it.`,
        );
      }

      const server = await servers.get(path.dirname(archive.path));
      const file = path.basename(archive.path);
      const config = inv.configs.find((c) => c.collection === archive.collection);

      const notes = [
        "Chrome 141+ and Edge require the Local Network Access permission for a page on replayweb.page to reach " +
          "localhost: the user must click Allow on the first load, or replay fails with " +
          '"An unexpected error occured: TypeError: Failed to fetch", which looks like a corrupt archive but is not. ' +
          "Dragging the .wacz onto replayweb.page avoids the permission entirely.",
      ];
      // Page search only works if the crawl wrote page text.
      if (config && !config.textToPages) {
        notes.push(`${archive.collection} was crawled without "text: to-pages", so it replays but is not full-text searchable.`);
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Serving ${file} (${humanBytes(archive.bytes)}) on port ${server.port}. Replay at:\n${server.url(file)}\n\n` +
              notes.join("\n\n"),
          },
        ],
        details: { port: server.port, url: server.url(file), archive },
      };
    },
  });

  const reviewTool = defineTool({
    name: "btrix_review",
    label: "Review",
    description:
      "Summarise what a finished crawl actually captured: page counts, http statuses, hosts, repeated titles, " +
      "pages with unusually little text, partial loads. It reports candidates, not conclusions — judge from them " +
      "whether the capture is faithful, whether pages came through as an anti-bot interstitial, and whether the " +
      "scope was what the user intended.",
    promptSnippet: "Review what a finished crawl captured",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Config or collection name. Defaults to the only crawl." })),
    }),
    async execute(_id, params) {
      const store = getStore();
      const legacy = getLegacy();
      const inv = await buildInventory(store, legacy);

      const asked = params.name ? normalizeName(String(params.name)) : undefined;
      const candidates = asked
        ? [asked]
        : [...new Set([...inv.runs.map((r) => r.config), ...inv.archives.map((a) => a.collection)])];
      if (candidates.length === 0) return text("Nothing has been crawled here yet.");
      if (candidates.length > 1) {
        return text(`Several crawls to choose from: ${candidates.join(", ")}. Ask for one by name.`);
      }
      const name = candidates[0]!;

      // A run directory still has the page index; read it live.
      const target = resolveTarget(store, monitor, name, legacy);
      if (target) {
        const dir = path.join(target.root, "collections", target.collection);
        const pages = readPages(dir);
        if (pages.found && pages.seed.length + pages.extra.length > 0) {
          const report = analyzePages(pages);
          const stats = await monitor.stats(target);
          // Only warn when work is actually still happening. Naming the
          // internal state here produced lines like "still no-stats".
          const header = isLive(stats)
            ? "Note: this crawl is still running, so the review is of a partial capture.\n"
            : "";
          return {
            content: [{ type: "text", text: header + reviewForModel(target.collection, report) }],
            details: { report, stats },
          };
        }
      }

      // Otherwise fall back to the report stored alongside the archive, which
      // survives the run directory being pruned.
      const archive = inv.archives.find(
        (a) => a.collection === name || a.provenance?.config === `${name}.yaml`,
      );
      if (archive) {
        const sidecarPath = path.join(store.outDir, `${archive.collection}.btrix.json`);
        try {
          const d = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as { review?: PagesReport };
          if (d.review) {
            return {
              content: [{ type: "text", text: reviewForModel(archive.collection, d.review) }],
              details: { report: d.review, fromSidecar: true },
            };
          }
        } catch {
          // No readable sidecar; fall through to the honest answer.
        }
        return text(
          `${archive.collection} has an archive at ${archive.path}, but no page index is available to review — ` +
            "its run directory is gone and the archive has no stored summary. Replay it with btrix_view instead.",
        );
      }

      return text(`Nothing to review for ${name}. btrix_list shows what is here.`);
    },
  });

  return [runTool, statusTool, listTool, viewTool, reviewTool];
}
