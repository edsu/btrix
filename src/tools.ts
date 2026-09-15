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
import {
  engineStatus,
  isCrawlRunning,
  killContainers,
  runningCrawls,
  runningProfileCaptures,
  stopCrawl,
} from "./engine.ts";
import { applyClean, type CleanTarget, planClean } from "./clean.ts";
import { buildInventory } from "./inventory.ts";
import type { CrawlMonitor, WatchTarget } from "./monitor.ts";
import type { Inventory } from "./inventory.ts";
import { analyzePages, type PagesReport, readPages } from "./pages.ts";
import { CONTAINER_PROFILES, findProfile, listProfiles, safeProfileName } from "./profile.ts";
import {
  inventoryForModel,
  isLive,
  renderForModel,
  renderInventory,
  renderReview,
  renderWidget,
  reviewForModel,
} from "./render.ts";
import type { ScratchBrowser } from "./browser.ts";
import { bundleAvailable, type ReplayServers } from "./serve.ts";
import { linesComponent } from "./tui.ts";
import { humanBytes } from "./sizes.ts";
import type { CrawlStats } from "./stats.ts";
import { activeRun, collectionFor, ensureStore, isSafeStoreName, prepareRun, type Store } from "./store.ts";
import { untrusted, UNTRUSTED_NOTE } from "./untrusted.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_SH = path.join(HERE, "..", "scripts", "run.sh");
const PROFILE_SH = path.join(HERE, "..", "scripts", "create-profile.sh");

/** How long to wait for the image pull and first log output before returning. */
const STARTUP_TIMEOUT_MS = 180_000;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** How a child ended. A signal kill carries a null code, which on its own
 *  renders as the unhelpful "exited with code null". */
function exitDescription(e: { code: number | null; signal: NodeJS.Signals | null }): string {
  return e.code === null ? `was killed by ${e.signal ?? "a signal"}` : `exited with code ${e.code}`;
}

/**
 * Accept "sulnews", "sulnews.yaml" or "sulnews.yml" alike, and tolerate a
 * leading "@" in case the completion trigger comes along for the ride.
 */
/** A page can return an arbitrarily large value; this is plenty to judge one by. */
const EVAL_VALUE_MAX = 2_000;

export function normalizeName(raw: string): string {
  return raw.trim().replace(/^@/, "").replace(/\.ya?ml$/, "");
}

/**
 * A config name that is safe to build a path from.
 *
 * normalizeName tidies input for display and is not a validator: a separator
 * or a `..` goes straight through it, and the name reaches both a
 * path.join into config/ and prepareRun's mkdir + cpSync. Same shape as
 * safeProfileName, for the same reason.
 */
export function safeConfigName(raw: string): string | undefined {
  const name = normalizeName(raw);
  return isSafeStoreName(name) ? name : undefined;
}

export function configPath(store: Store, name: string): string | undefined {
  // The choke point for every read: an unsafe name resolves to nothing rather
  // than to a file outside the store.
  if (!safeConfigName(name)) return undefined;
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
  browser?: ScratchBrowser,
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
    renderCall(args, theme) {
      return linesComponent([`${theme.fg("accent", "crawl")} ${theme.fg("text", normalizeName(String(args.config ?? "?")))}`]);
    },
    renderResult(result, _options, theme) {
      const stats = result.details as CrawlStats | undefined;
      if (!stats?.name) return linesComponent(result.content.map((c: any) => String(c.text ?? "")));
      // Just a confirmation. The widget above the editor is already showing the
      // live figures, and drawing them here too put the same block on screen
      // twice.
      const counts = stats.total ? `${stats.crawled}/${stats.total}` : `${stats.crawled} pages`;
      return linesComponent([
        `${theme.fg("accent", "crawling")} ${theme.fg("text", stats.name)} ${theme.fg("dim", `${counts} · progress below`)}`,
      ]);
    },
    async execute(_id, params, signal, onUpdate) {
      const store = getStore();
      const config = normalizeName(String(params.config));

      const engine = await engineStatus();
      if (!engine.usable) return text(engine.problem ?? "No container engine available.");

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

      // isCrawlRunning is deliberately tri-state: undefined means the engine
      // did not answer, which is not the same as "nothing is running". A
      // `docker ps` that times out under the load of an in-flight crawl would
      // otherwise fall through and start a second crawler for the same config,
      // both writing the same collection and fighting over the screencast port.
      const already = await isCrawlRunning(config);
      if (already === undefined) {
        return text(
          `Could not ask ${engine.bin ?? "the container engine"} what is running, so starting a crawl now ` +
            `risks running two for ${config} at once. Check with \`${engine.bin ?? "docker"} ps\` and try again.`,
        );
      }
      if (already) {
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
      // The profiles directory is mounted in, so a config referencing
      // /crawls/profiles/<name>.tar.gz resolves during the crawl.
      const child = spawn("bash", [RUN_SH, config, runDir, store.profilesDir], {
        cwd: store.root,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      fs.closeSync(out);
      monitor.watch(target);

      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.on("exit", (code, signal) => {
        exited = { code, signal };
      });

      // Wait out the image pull and the first statistics line. This window is
      // what the tool's AbortSignal cancels; after it, the crawl is on its own.
      onUpdate?.({ content: [{ type: "text", text: `pulling image and starting ${config}…` }], details: {} });
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let announcedContainer = false;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          // Graceful even here: the crawler may already have written something.
          await stopCrawl(config, 10);
          return text(`Cancelled; stopped the ${config} crawl. Partial output is in ${runDir}.`);
        }
        const stats = await monitor.stats(target);
        if (stats.crawled > 0 || stats.total > 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Started ${config}. ${renderForModel(stats)}\n` +
                  "Progress renders itself from here. Say it started and leave the figures to the widget; " +
                  "you will be told when it finishes.",
              },
            ],
            details: stats,
          };
        }
        if (stats.containerRunning && !announcedContainer) {
          announcedContainer = true;
          onUpdate?.({ content: [{ type: "text", text: "container up, waiting for first statistics…" }], details: {} });
        }
        if (exited && exited.code !== 0 && !stats.containerRunning) {
          const tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-12).join("\n");
          return text(`The runner ${exitDescription(exited)} before crawling started:\n\n${tail}`);
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
    renderResult(result, _options, theme) {
      const stats = result.details as CrawlStats | undefined;
      if (!stats?.name) return linesComponent(result.content.map((c: any) => String(c.text ?? "")));
      return linesComponent(renderWidget(stats, theme));
    },
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
      // Only follow it if there is something to follow; watching a finished
      // crawl would park it in the widget as though it were still going.
      if (isLive(stats)) monitor.watch(target);
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
    renderResult(result, _options, theme) {
      const inv = result.details as Inventory | undefined;
      // The table was already built for the widget; render it rather than
      // handing a prose version of it to the model to read back.
      if (!inv?.store) return linesComponent(result.content.map((c: any) => String(c.text ?? "")));
      return linesComponent(renderInventory(inv, theme));
    },
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
    renderResult(result, options, theme) {
      const d = result.details as { url?: string; port?: number } | undefined;
      if (!d?.url) return linesComponent(result.content.map((c: any) => String(c.text ?? "")));
      const lines = [theme.fg("mdLink", d.url), theme.fg("dim", `served on port ${d.port}`)];
      // The troubleshooting is long; keep it for the expanded view.
      if (options.expanded) {
        lines.push(...result.content.map((c: any) => theme.fg("dim", String(c.text ?? ""))));
      } else {
        lines.push(theme.fg("dim", "viewer and archive are both served locally — nothing leaves this machine"));
      }
      return linesComponent(lines);
    },
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

      const notes: string[] = [];

      // With the viewer served from the same origin there is no permission to
      // grant and no cross-origin fetch to refuse, so there is nothing to warn
      // about. Without it the link goes to replayweb.page, which is the case
      // that fails: on 2026-09-15 the same archive failed in Chrome 153 and in
      // Zen that way and replayed in both from the loopback origin. No prompt
      // was offered in either, so do not tell anyone to click Allow.
      if (!bundleAvailable()) {
        notes.push(
          "The replay viewer is not vendored in, so this link goes to replayweb.page — a public page fetching " +
            "127.0.0.1, which some browsers and LAN-blocking extensions refuse with \"An unexpected error " +
            "occured: TypeError: Failed to fetch\". That reads like a corrupt capture and is not one. Run " +
            "scripts/vendor-replay.sh to serve the viewer locally, or drag " +
            `${archive.path} onto replayweb.page, which reads from disk and always works.`,
        );
      }
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
    renderResult(result, _options, theme) {
      const d = result.details as { report?: PagesReport; stats?: CrawlStats } | undefined;
      if (!d?.report) return linesComponent(result.content.map((c: any) => String(c.text ?? "")));
      return linesComponent(renderReview(d.stats?.name ?? "crawl", d.report, theme));
    },
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

  const profileTool = defineTool({
    name: "btrix_profile",
    label: "Login profile",
    description:
      "Start a browser, served over noVNC, in which the USER logs in to a site by hand; the resulting login " +
      "profile is saved for authenticated crawls. Called with no url, it lists the profiles that already exist. " +
      "You must never enter the user's credentials, and must not ask them for a password: they type it into that " +
      "browser themselves. Relay the instructions in the result verbatim.",
    promptSnippet: "Create or list browser login profiles for authenticated crawls",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: "Login page or a page on the site to authenticate against. Omit to list profiles." }),
      ),
      name: Type.Optional(Type.String({ description: "Profile name. Defaults to the site host." })),
    }),
    async execute(_id, params, signal, onUpdate) {
      const store = getStore();
      const existing = listProfiles(store);

      if (!params.url) {
        if (!existing.length) {
          return text(
            `No login profiles in ${store.profilesDir}. Call btrix_profile with the login page url to make one.`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text:
                `${existing.length} login profile(s) in ${store.profilesDir}:\n` +
                existing
                  .map(
                    (p) =>
                      `  ${p.name} · ${humanBytes(p.bytes)} · made ${p.modified?.toISOString().slice(0, 10) ?? "?"} · ` +
                      `use with  profile: ${p.configValue}`,
                  )
                  .join("\n") +
                "\n\nSession cookies expire, so an old profile may no longer be logged in; remake it if a crawl " +
                "comes back with login pages.",
            },
          ],
          details: existing,
        };
      }

      let url: URL;
      try {
        url = new URL(String(params.url));
      } catch {
        return text(`"${params.url}" is not a url. Give the login page, for example https://example.org/login.`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return text("Only http and https urls can be used for a login profile.");
      }
      // Credentials in a url would end up in the container command line, in
      // `docker ps`, and in this session's transcript.
      if (url.username || url.password) {
        return text(
          "That url contains credentials. Give the plain login page url instead — you will type your username " +
            "and password into the browser yourself, and btrix never handles them.",
        );
      }

      const requested = params.name ? String(params.name) : url.host.replace(/^www\./, "");
      const name = safeProfileName(requested);
      if (!name) {
        return text(
          `"${requested}" is not usable as a profile name. Use letters, numbers, dots, dashes or underscores.`,
        );
      }

      const already = findProfile(store, name);
      const inFlight = await runningProfileCaptures();
      if (inFlight.length) {
        return text(
          `A profile browser is already running (port 6080 is in use by it). Finish or stop that one first` +
            (inFlight[0]?.filename ? `: it is capturing "${inFlight[0].filename}".` : "."),
        );
      }

      ensureStore(store);
      fs.mkdirSync(store.profilesDir, { recursive: true, mode: 0o700 });

      const logPath = path.join(store.profilesDir, `.${name}.log`);
      const out = fs.openSync(logPath, "a");
      const child = spawn("bash", [PROFILE_SH, url.toString(), store.profilesDir, name], {
        cwd: store.root,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      fs.closeSync(out);

      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.on("exit", (code, signal) => {
        exited = { code, signal };
      });

      onUpdate?.({ content: [{ type: "text", text: "pulling image and starting the browser…" }], details: {} });

      // Wait only for the browser to be reachable. The login itself takes as
      // long as it takes, and is not something to hold a tool call open for.
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let up = false;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          // Whatever came up under us is the capture we started.
          await killContainers((await runningProfileCaptures()).map((c) => c.id));
          return text("Cancelled; stopped the profile browser.");
        }
        if ((await runningProfileCaptures()).length) {
          up = true;
          break;
        }
        if (exited && exited.code !== 0) {
          const tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-12).join("\n");
          return text(`The profile browser ${exitDescription(exited)}:\n\n${tail}`);
        }
        await sleep(1_500);
      }

      const target = path.join(store.profilesDir, `${name}.tar.gz`);
      const instructions = [
        up
          ? `A browser is running for ${url.host}. Hand these steps to the user:`
          : `The profile browser is starting for ${url.host} (it may still be pulling the image). Hand these steps to the user:`,
        "",
        "  1. Open http://127.0.0.1:6080 in your browser.",
        "  2. Log in to the site yourself, in that window. Complete any two-factor step.",
        "  3. Use the on-screen control to save the profile.",
        "",
        `It will be written to ${target}.`,
        `Then add this to the crawl config:  profile: ${CONTAINER_PROFILES}/${name}.tar.gz`,
        "",
        "Do not type the user's password for them and do not ask for it — they enter it in that browser.",
        "The profile contains session cookies, so it is a credential: the store's .gitignore keeps it out of",
        "version control, and it should not be shared or copied between machines.",
        already ? `\nNote: a profile called ${name} already exists and will be replaced when this one is saved.` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text", text: instructions }], details: { name, target, url: url.toString() } };
    },
  });

  const stopTool = defineTool({
    name: "btrix_stop",
    label: "Stop crawl",
    description:
      "Stop a running crawl. The crawler is asked to shut down and given time to close its files, so whatever " +
      "it captured so far stays usable and is kept. Use when a crawl is taking far longer than intended, is " +
      "being rate-limited hard, or was started with the wrong scope.",
    promptSnippet: "Stop a running Browsertrix crawl",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Config name. Defaults to the only running crawl." })),
    }),
    async execute(_id, params) {
      const running = (await runningCrawls()).map((c) => c.config).filter((n): n is string => !!n);
      if (!running.length) return text("No crawl is running.");

      let name = params.name ? normalizeName(String(params.name)) : undefined;
      if (!name) {
        if (running.length > 1) {
          return text(`Several crawls are running: ${running.join(", ")}. Say which one to stop.`);
        }
        name = running[0];
      }
      if (!running.includes(name!)) {
        return text(`${name} is not running. Currently running: ${running.join(", ")}`);
      }

      const stopped = await stopCrawl(name!);
      if (!stopped) return text(`Could not stop ${name}; it may have finished on its own.`);
      return text(
        `Stopped ${name}. The crawler was given time to close its files, so the pages it had already captured ` +
          "are intact — btrix will report where they ended up once the container exits.",
      );
    },
  });

  const cleanTool = defineTool({
    name: "btrix_clean",
    label: "Reclaim space",
    description:
      "Report, and optionally delete, the working directories left behind by finished and failed crawls. " +
      "Never touches archives, configs or profiles — including a wacz still sitting in a run directory " +
      "because the session ended before the crawl did. Reports by default. With remove set, btrix asks " +
      "the user to confirm the exact list before anything is deleted, so show them the report first.",
    promptSnippet: "Reclaim space from old crawl working directories",
    parameters: Type.Object({
      // Plain string rather than an enum: the enum helper lives in a package
      // that is only a transitive dependency here, and the value is validated
      // below anyway.
      what: Type.Optional(
        Type.String({ description: 'One of "failed" (default), "runs", or "both"' }),
      ),
      olderThanDays: Type.Optional(Type.Number({ description: "Only consider directories older than this" })),
      remove: Type.Optional(Type.Boolean({ description: "Actually delete. Defaults to false: report only." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = getStore();
      const asked = params.what ? String(params.what) : "failed";
      if (!["failed", "runs", "both"].includes(asked)) {
        return text(`"${asked}" is not one of failed, runs, both.`);
      }
      const plan = await planClean(store, {
        what: asked as CleanTarget,
        olderThanDays: typeof params.olderThanDays === "number" ? params.olderThanDays : undefined,
      });

      if (!plan.candidates.length) {
        const kept = plan.kept.length ? ` ${plan.kept.length} kept: ${plan.kept.map((k) => k.keptBecause).join("; ")}.` : "";
        return text(`Nothing to reclaim.${kept}`);
      }

      const listing = plan.candidates
        .map((c) => `  ${path.basename(c.path)} · ${c.kind} · ${humanBytes(c.bytes)} · ${c.ageDays}d old`)
        .join("\n");

      if (!params.remove) {
        return {
          content: [
            {
              type: "text",
              text:
                `${plan.candidates.length} directory(ies) holding ${humanBytes(plan.totalBytes)} could be removed:\n` +
                `${listing}\n\n` +
                (plan.kept.length ? `Keeping ${plan.kept.length}: ${plan.kept.map((k) => k.keptBecause).join("; ")}.\n` : "") +
                "Archives, configs and profiles are never touched. Nothing has been deleted — show the user this " +
                "list and ask before calling again with remove.",
            },
          ],
          details: plan,
        };
      }

      // Asked here rather than in a tool_call gate so there is exactly one
      // plan: the gate would have to compute its own, and then the list shown
      // is not provably the list deleted. This is the only thing in btrix that
      // deletes, so the description telling the model to ask first is not
      // enough on its own.
      if (ctx?.hasUI) {
        const ok = await ctx.ui.confirm(
          `Delete ${plan.candidates.length} directory(ies), freeing ${humanBytes(plan.totalBytes)}?`,
          `${listing}\n\nThis cannot be undone.`,
        );
        if (!ok) return text("Left alone — nothing was deleted.");
      }

      const { removed, refused, bytes } = await applyClean(store, plan);
      return {
        content: [
          {
            type: "text",
            text:
              `Removed ${removed.length} directory(ies), reclaiming about ${humanBytes(bytes)}.` +
              (refused.length ? ` ${refused.length} could not be removed: ${refused.join(", ")}` : ""),
          },
        ],
        details: { removed, refused, bytes },
      };
    },
  });

  const browserTool = defineTool({
    name: "btrix_browser",
    label: "Scratch browser",
    description:
      "Open a real browser on a page, for working out what a custom behavior needs to do. Defaults to a local " +
      "Chrome in a native window, with real DevTools on F12; pass crawler for the browser the crawler itself " +
      "runs, watched over noVNC, which is worth trying when a selector works locally but fails in a crawl. " +
      "Either way it is a throwaway browser with a fresh profile — never the user's own browsing session, and " +
      "it saves nothing. Call with no url to see what is open, or stop to close it.",
    promptSnippet: "Open a real browser on a page to work out a behavior",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Page to open. Omit to report what is already open." })),
      stop: Type.Optional(Type.Boolean({ description: "Close the browser." })),
      use: Type.Optional(
        Type.String({ description: 'Which browser: "local" (default) or "crawler" for the container\'s' }),
      ),
    }),
    async execute(_id, params, _signal, onUpdate) {
      if (!browser) return text("The scratch browser is unavailable: no browser manager was wired up.");

      if (params.stop) {
        if (!browser.isRunning()) return text("No scratch browser is running.");
        await browser.stop();
        return text("Closed the scratch browser.");
      }

      if (!params.url) {
        if (!browser.isRunning()) {
          return text("No scratch browser is running. Call btrix_browser with a url to start one.");
        }
        const info = await browser.info();
        const where = browser.runningKind() === "container" ? ` Watch it at ${browser.vncUrl()}` : "";
        return info.ok
          ? text(`The ${browser.runningKind()} browser has ${info.url} open ("${info.title}").${where}`)
          : text(`The scratch browser is not answering: ${info.error}`);
      }

      let url: URL;
      try {
        url = new URL(String(params.url));
      } catch {
        return text(`"${params.url}" is not a url.`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return text("Only http and https urls can be opened.");
      }

      const asked = params.use ? String(params.use).toLowerCase() : "local";
      if (!["local", "crawler", "container"].includes(asked)) {
        return text(`"${asked}" is not a browser. Use "local" or "crawler".`);
      }
      const kind = asked === "local" ? "local" : "container";

      // Only the container browser needs an engine.
      if (kind === "container") {
        const engine = await engineStatus();
        if (!engine.usable) return text(engine.problem ?? "No container engine available.");
      }

      const opened = await browser.open(url.toString(), { kind }, (note) =>
        onUpdate?.({ content: [{ type: "text", text: note }], details: {} }),
      );
      if (!opened.ok) {
        const alternative =
          kind === "local"
            ? ' The crawler\'s own browser is another option: pass use="crawler".'
            : ' A local browser is another option: pass use="local".';
        return text(`Could not open the ${kind} browser: ${opened.error}${alternative}`);
      }

      const watch = opened.vnc ? ` Watch and click it at ${opened.vnc}` : " It is open in a window on your desktop.";
      return {
        content: [
          {
            type: "text",
            text:
              `Open on ${opened.url} ("${opened.title}").${watch}\n` +
              "Use btrix_eval to try selectors and interaction code against this page.",
          },
        ],
        details: { url: opened.url, title: opened.title, kind: opened.kind, vnc: opened.vnc },
      };
    },
  });

  const evalTool = defineTool({
    name: "btrix_eval",
    label: "Evaluate",
    description:
      "Evaluate a JavaScript expression in the scratch browser's open page and return its value plus anything it " +
      "logged to the console. This is how to work out a behavior: count what a selector matches, click something " +
      "and count again, read scrollHeight. It runs only in the throwaway browser btrix_browser opened — a fresh " +
      "profile with nothing signed in — and never the user's own browsing session.",
    promptSnippet: "Evaluate JavaScript in the scratch browser's page",
    promptGuidelines: [
      "Use btrix_eval to check a selector against the real page before putting it in a behavior.",
    ],
    parameters: Type.Object({
      js: Type.String({ description: "An expression. Wrap statements in an IIFE and return a value." }),
    }),
    async execute(_id, params) {
      if (!browser) return text("The scratch browser is unavailable: no browser manager was wired up.");
      if (!browser.isRunning()) {
        return text("No scratch browser is running. Open a page with btrix_browser first.");
      }

      const r = await browser.eval(String(params.js));
      const parts: string[] = [];
      // The value has to arrive intact — inspecting it is the point of the
      // tool — so it is capped rather than reshaped. Everything around it is
      // page-controlled too, and gets the usual marking.
      if (r.ok) {
        const shown = JSON.stringify(r.value) ?? "undefined";
        parts.push(`=> ${shown.length > EVAL_VALUE_MAX ? `${shown.slice(0, EVAL_VALUE_MAX - 1)}…` : shown}`);
      } else parts.push(`threw: ${untrusted(r.error, "unknown error")}`);
      if (r.console.length) {
        parts.push(`console (${UNTRUSTED_NOTE}):\n${r.console.map((l) => `  ${untrusted(l)}`).join("\n")}`);
      }
      if (r.url) parts.push(`page: ${untrusted(r.url)}`);
      return { content: [{ type: "text", text: parts.join("\n") }], details: r };
    },
  });

  return [
    runTool,
    statusTool,
    listTool,
    viewTool,
    reviewTool,
    profileTool,
    stopTool,
    cleanTool,
    browserTool,
    evalTool,
  ];
}
