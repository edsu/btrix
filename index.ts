/**
 * btrix — drive Browsertrix Crawler from pi.
 *
 * Wiring only. The crawl logic lives in src/, which knows nothing about pi.
 *
 * The shape of this extension follows from one observation about the Claude
 * Code plugin it replaces: there, the model was the renderer. Every status
 * refresh cost a turn, the "interpretation" the skills asked for was a set of
 * deterministic rules written as prose, and a single-snapshot script could not
 * supply the history those rules needed. Here the widget renders the facts
 * continuously for free, and the model is left the work it is actually good at.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { finishRun, type Outcome } from "./src/finish.ts";
import { ScratchBrowser, VNC_PORT } from "./src/browser.ts";
import { CrawlMonitor, type WatchTarget } from "./src/monitor.ts";
import { notifyDesktop } from "./src/notify.ts";
import { isLive, renderForModel, renderInventory, renderWidget, startupLines, supportsUnicode } from "./src/render.ts";
import { listArchiveFiles, ReplayServers } from "./src/serve.ts";
import { linesComponent } from "./src/tui.ts";
import { humanBytes } from "./src/sizes.ts";
import type { CrawlStats } from "./src/stats.ts";
import { wordmarkLines } from "./src/wordmark.ts";
import { activeRun, collectionFor, legacyRoot, resolveStore, type Store } from "./src/store.ts";
import { applyNameCompletion, filterSuggestions, nameSuggestions, tokenBeforeCursor } from "./src/complete.ts";
import { readConfig } from "./src/config.ts";
import { confirmCrawl, isOpenEnded } from "./src/confirm.ts";
import { engineStatus } from "./src/engine.ts";
import { firstRunPanel, modelLabel, probeAuth, readyHeader } from "./src/firstrun.ts";
import { buildInventory } from "./src/inventory.ts";
import { listProfiles } from "./src/profile.ts";
import { configPath, createTools, listConfigs, normalizeName } from "./src/tools.ts";
import { refuseGlob, refuseRead, refuseSearch, refuseWrite, type Scope } from "./src/paths.ts";
import { resolveAgentDir } from "./src/agentdir.js";

/** Free space below which starting a crawl is worth a confirmation. */
const LOW_DISK_BYTES = 5 * 1024 ** 3;

/** The installed package, which is where the skills keep their reference docs. */
const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));

const widgetKey = (config: string) => `btrix:${config}`;

interface SummaryCard {
  stats: CrawlStats;
  outcome: Outcome;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("dir", {
    description: "btrix store directory (default: ./btrix)",
    type: "string",
  });

  const cwd = process.cwd();
  // Only rewritten when it changes: the title costs an escape sequence a paint.
  let lastTitle = "";
  // Resolved once the CLI has parsed --dir, at session_start.
  let store: Store = resolveStore({ cwd });
  let legacy = legacyRoot(cwd);
  let ctxRef: ExtensionContext | undefined;

  const monitor = new CrawlMonitor({
    intervalMs: 1_000,
    onTick(stats, target) {
      const ctx = ctxRef;
      if (!ctx?.hasUI) return;
      ctx.ui.setWidget(widgetKey(target.config), () =>
        linesComponent(renderWidget(stats, ctx.ui.theme), { overflow: "clip" }),
      );

      // Progress in the terminal title, so a long crawl is legible from a
      // backgrounded tab without switching to it.
      const title = stats.total
        ? `btrix - ${target.collection} ${stats.crawled}/${stats.total}`
        : `btrix - ${target.collection} ${stats.crawled} pages`;
      if (title !== lastTitle) {
        lastTitle = title;
        ctx.ui.setTitle(title);
      }
    },
    async onComplete(stats, target) {
      const ctx = ctxRef;
      // Clear the live widget; the durable card takes over.
      ctx?.ui.setWidget(widgetKey(target.config), undefined);

      // Promote the deliverable out of the run directory before announcing
      // anything, so the card and the model both name its final location.
      let outcome: Outcome;
      try {
        outcome = await finishRun(store, target, stats);
      } catch (err) {
        outcome = {
          kind: "failed",
          message: `${target.collection}: finished, but moving the result failed — ${String(err)}`,
        };
      }

      // Custom entries do not enter LLM context, so the card costs nothing.
      pi.appendEntry<SummaryCard>("btrix-summary", { stats, outcome });

      // A crawl that ran for hours finishes into a window nobody is watching.
      notifyDesktop(
        outcome.kind === "promoted" ? `Crawl finished: ${stats.name}` : `Crawl ended: ${stats.name}`,
        outcome.kind === "promoted"
          ? `${stats.crawled} pages, ${humanBytes(stats.bytes.wacz ?? stats.bytes.archive)}`
          : outcome.message,
      );
      if (ctx?.hasUI) {
        lastTitle = "btrix";
        ctx.ui.setTitle("btrix");
      }

      // One message, one turn: the model announces the result and can offer a
      // review. This replaces Claude Code's background-task completion
      // notification, which the old run skill relied on.
      pi.sendMessage(
        {
          customType: "btrix",
          content: `${outcome.message} ${renderForModel(stats)}`,
          display: false,
          details: { stats, outcome },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  // Replay servers are session-scoped: unlike a crawl, a stray HTTP server
  // serving your archives after you quit is not something anyone wants.
  const servers = new ReplayServers();
  // Same lifecycle reasoning as the replay servers: a crawl is detached because
  // it should outlive the session, a stray Chrome should not.
  const browser = new ScratchBrowser(() => store.chromeProfileDir);

  for (const tool of createTools(
    monitor,
    () => store,
    () => legacy,
    servers,
    browser,
  )) {
    pi.registerTool(tool);
  }

  pi.registerEntryRenderer<SummaryCard>("btrix-summary", (entry, { expanded }, theme) => {
    const s = entry.data?.stats;
    const outcome = entry.data?.outcome;
    if (!s) return undefined;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    const ok = outcome?.kind !== "failed";
    const size = s.bytes.wacz ?? s.bytes.archive;
    box.addChild(
      new Text(
        `${theme.fg(ok ? "success" : "warning", ok ? "✓ crawl finished" : "⚠ crawl ended early")} ` +
          `${theme.fg("text", s.name)} ${theme.fg("dim", `${s.crawled}/${s.total} pages · ${humanBytes(size)}`)}`,
        0,
        0,
      ),
    );
    if (outcome?.dest) box.addChild(new Text(theme.fg("mdLink", outcome.dest), 0, 0));
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", renderForModel(s)), 0, 0));
      if (outcome?.parked) box.addChild(new Text(theme.fg("dim", `run kept at ${outcome.parked}`), 0, 0));
    }
    return box;
  });

  /** Resolve a config name to the run it is writing into. */
  const targetFor = (config: string): WatchTarget | undefined => {
    const file = configPath(store, config);
    const collection = file ? collectionFor(file, config) : config;
    const root = activeRun(store, config, collection);
    if (root) return { config, collection, root };
    // A crawl running against a legacy or hand-made working directory.
    if (legacy) return { config, collection, root: legacy };
    return undefined;
  };

  /** The footer's model line, in one place so it cannot drift out of date. */
  const showModel = (ctx: ExtensionContext, label: string): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("btrix", ctx.ui.theme.fg("dim", `${store.root} · ${label} · /model to change`));
  };

  // Switching with /model has to update the footer, or it quietly keeps
  // reporting the model the session started with.
  pi.on("model_select", async (event, ctx) => {
    const model = (event as { model?: { provider?: string; id?: string } }).model;
    showModel(ctx, model?.provider && model.id ? `${model.provider}/${model.id}` : "unknown model");
    return undefined;
  });

  /**
   * Open a url in the desktop browser. Only ever localhost and replayweb.page,
   * and only when the user pressed the key.
   */
  const openUrl = async (url: string): Promise<void> => {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    await pi.exec(opener, [url], { timeout: 5_000 }).catch(() => undefined);
  };

  // Commands rather than key shortcuts: pi's built-ins occupy nearly every
  // ctrl+letter, so binding one either steals a binding the user already has
  // (ctrl+r is session rename) or is silently dropped as a conflict.
  pi.registerCommand("replay", {
    description: "Open the replay link for a served archive in your browser",
    handler: async (args, ctx) => {
      const live = servers.running();
      if (!live.length) {
        ctx.ui.notify("No replay server running — ask to replay an archive first.", "info");
        return;
      }
      const server = live[0]!;
      const archives = listArchiveFiles(server.dir);
      if (!archives.length) {
        ctx.ui.notify("Nothing to replay in the served directory.", "warning");
        return;
      }
      const asked = args.trim();
      const named = asked ? archives.find((a) => a.startsWith(asked.replace(/\.wacz$/, ""))) : undefined;
      const file =
        named ?? (archives.length === 1 ? archives[0]! : await ctx.ui.select("Replay which archive?", archives));
      if (!file) return;
      await openUrl(server.url(file));
    },
  });

  pi.registerCommand("screencast", {
    description: "Open the live crawl screencast in your browser",
    handler: async (_args, ctx) => {
      if (!monitor.watched().length) {
        ctx.ui.notify("No crawl is running.", "info");
        return;
      }
      await openUrl("http://127.0.0.1:9037/");
    },
  });

  /** Manual readout, rendered for the human without involving the model. */
  pi.registerCommand("btrix", {
    description: "Show Browsertrix crawl progress in the widget (no model turn)",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const name = args.trim();
      if (name) {
        const target = targetFor(name);
        if (!target) {
          ctx.ui.notify(`No crawl found for ${name}.`, "warning");
          return;
        }
        // Watching something already finished puts it back on screen as
        // though it were live, and `sawLive` never becomes true for a crawl
        // that was terminal when we found it — so the entry never settles,
        // the widget keeps showing it, and the 1 Hz loop spawns a `docker ps`
        // a second for the rest of the session. Show the readout instead.
        const stats = await monitor.stats(target);
        if (isLive(stats)) {
          monitor.watch(target);
          await monitor.tick();
        } else if (ctx.hasUI) {
          ctx.ui.setWidget(widgetKey(target.config), () =>
            linesComponent(renderWidget(stats, ctx.ui.theme), { overflow: "clip" }),
          );
        }
        return;
      }

      await monitor.adoptRunning(targetFor);
      await monitor.tick();
      // Nothing live to watch: show the inventory instead of an empty widget.
      // Rendered here, so asking "what do I have?" costs no model turn.
      if (monitor.watched().length === 0) {
        const inv = await buildInventory(store, legacy);
        ctx.ui.setWidget("btrix:inventory", () => linesComponent(renderInventory(inv, ctx.ui.theme)), {
          placement: "belowEditor",
        });
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;

    // Someone who installed btrix has not necessarily heard of pi, and with no
    // credentials the runtime's own message names itself and a node_modules
    // path. Get in front of that with something actionable.
    const auth = probeAuth(ctx.modelRegistry as never);
    if (ctx.hasUI) {
      if (!auth.ready) {
        ctx.ui.setWidget("btrix:firstrun", () => linesComponent(firstRunPanel(auth)), {
          placement: "belowEditor",
        });
      } else {
        ctx.ui.setWidget("btrix:firstrun", undefined);
        ctx.ui.setTitle("btrix");
      }
    }

    // --dir is only available once the CLI has parsed it.
    const flag = pi.getFlag("dir");
    store = resolveStore({ dir: typeof flag === "string" ? flag : undefined, cwd: ctx.cwd ?? cwd });
    legacy = legacyRoot(ctx.cwd ?? cwd);

    // State lives on disk, not in the session: a crawl started in another
    // session, or by hand, is picked up here and gets a widget.
    const adopted = await monitor.adoptRunning(targetFor);
    if (adopted.length) await monitor.tick();

    if (ctx.hasUI) {
      // Complete crawl names on `@`, from the inventory. Rebuilt per query
      // rather than cached: a crawl finishing changes what the names mean.
      ctx.ui.addAutocompleteProvider(() => ({
        triggerCharacters: ["@"],
        async getSuggestions(lines, cursorLine, cursorCol) {
          const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
          const token = tokenBeforeCursor(before);
          if (token === undefined) return null;
          const inv = await buildInventory(store, legacy);
          const items = filterSuggestions(nameSuggestions(inv, listProfiles(store)), token).slice(0, 20);
          if (!items.length) return null;
          return { items, prefix: `@${token}` };
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return applyNameCompletion(lines, cursorLine, cursorCol, item.value, prefix);
        },
      }));
    }

    if (ctx.hasUI && auth.ready) {
      showModel(ctx, modelLabel(auth.model));

      // Replace the harness's banner with ours. The engine check is the
      // important part: finding out that Docker is absent or asleep here beats
      // finding out several minutes into an image pull.
      const [engine, inv] = await Promise.all([engineStatus(), buildInventory(store, legacy)]);
      // A different gradient each start, or a flat theme colour where the
      // terminal cannot do 24-bit colour.
      const { lines: wordmark } = wordmarkLines({ plain: (l) => ctx.ui.theme.fg("accent", l) });
      const banner = startupLines(
        {
          inv,
          engine,
          model: readyHeader(auth, store.root)[1],
          adopted: adopted.map((t) => t.config),
          unicode: supportsUnicode(),
          wordmark,
        },
        ctx.ui.theme,
      );
      ctx.ui.setHeader(() => linesComponent(banner));
    }
  });

  // Confirmation gate. pi ships no permission system by design, so anything
  // worth a prompt is ours to ask.
  pi.on("turn_start", async (_event, ctx) => {
    // The user may have run /login since startup.
    if (ctx.hasUI && probeAuth(ctx.modelRegistry as never).ready) {
      ctx.ui.setWidget("btrix:firstrun", undefined);
    }
    return undefined;
  });

  pi.on("tool_result", async (_event, ctx) => {
    if (!ctx.hasUI) return undefined;
    const bits: string[] = [];
    const live = servers.running();
    if (live.length) bits.push(`replay :${live.map((s) => s.port).join(",")}`);
    if (browser.runningKind() === "container") bits.push(`browser :${VNC_PORT}`);
    else if (browser.isRunning()) bits.push("browser (local)");
    ctx.ui.setStatus("btrix-replay", bits.length ? ctx.ui.theme.fg("dim", bits.join(" · ")) : undefined);
    return undefined;
  });

  /**
   * Where the model may write. Recomputed per call so a `--dir` store and a
   * relative path are both resolved against what is true now.
   */
  const scope = (): Scope => ({
    cwd: process.cwd(),
    storeRoot: store.root,
    agentDir: resolveAgentDir(),
    packageRoot: PKG_ROOT,
  });

  pi.on("tool_call", async (event, ctx) => {
    // pi ships no permission system by design, and `write` and `edit` are
    // handed to the model so it can author configs and behaviors. Nothing
    // scopes them to this project, so scope them here: a crawl reads pages
    // nobody vetted, and their titles reach the model as text. (`bash` is not
    // granted at all -- see toolnames.js.)
    if (event.toolName === "write" || event.toolName === "edit") {
      const refusal = refuseWrite(scope(), String((event.input as { path?: unknown }).path ?? ""));
      return refusal ? { block: true, reason: refusal } : undefined;
    }

    if (event.toolName === "read") {
      const refusal = refuseRead(scope(), String((event.input as { path?: unknown }).path ?? ""));
      return refusal ? { block: true, reason: refusal } : undefined;
    }

    // ls, grep and find replace what bash was granted for. Their path is
    // optional, and both glob-taking tools expand their pattern after the path
    // is checked, so the pattern is checked too.
    if (event.toolName === "ls" || event.toolName === "grep" || event.toolName === "find") {
      const input = event.input as { path?: unknown; glob?: unknown; pattern?: unknown };
      const refusal =
        refuseSearch(scope(), input.path === undefined ? undefined : String(input.path)) ??
        refuseGlob(input.glob === undefined ? undefined : String(input.glob)) ??
        // find's `pattern` is a glob; grep's is a regex over file contents and
        // is not a path, so only find's is checked.
        (event.toolName === "find" && input.pattern !== undefined
          ? refuseGlob(String(input.pattern))
          : undefined);
      return refusal ? { block: true, reason: refusal } : undefined;
    }

    if (event.toolName !== "btrix_run") return undefined;

    // The same normalisation the tool applies, or a name the tool accepts but
    // this handler does not — "@sulnews", " sulnews" — resolves to no config
    // here, returns early, and runs the crawl with no scope confirmation.
    const name = normalizeName(String((event.input as { config?: unknown }).config ?? ""));
    const file = configPath(store, name);
    if (!file) return undefined; // The tool reports a missing config better than we can.

    const config = readConfig(file, name);
    const inv = await buildInventory(store, legacy).catch(() => undefined);

    if (!ctx.hasUI) {
      // No dialog available, so apply the same judgements without asking.
      if (inv?.free !== undefined && inv.free < LOW_DISK_BYTES) {
        return { block: true, reason: `Only ${humanBytes(inv.free)} free; the crawler aborts when the disk fills.` };
      }
      // This used to stop at the disk check, which quietly made a headless
      // session the one place an unbounded whole-host crawl could start --
      // the mistake confirmCrawl exists to catch, and the expensive one.
      if (isOpenEnded(config)) {
        return {
          block: true,
          reason:
            `${name} is scoped to the whole ${config.scopeType} with no pageLimit, and there is no UI to confirm ` +
            "that in. Set a pageLimit, narrow the scope, or run btrix interactively.",
        };
      }
      return undefined;
    }

    const verdict = await confirmCrawl(
      { select: (t, o) => ctx.ui.select(t, o), confirm: (t, m) => ctx.ui.confirm(t, m) },
      config,
      inv?.free,
      LOW_DISK_BYTES,
    );
    return verdict.proceed ? undefined : { block: true, reason: verdict.reason };
  });

  // Idempotent: stop rendering, but leave the containers running. A detached
  // crawl outliving the session is the point.
  pi.on("session_shutdown", async () => {
    for (const target of monitor.watched()) ctxRef?.ui.setWidget(widgetKey(target.config), undefined);
    ctxRef?.ui.setWidget("btrix:inventory", undefined);
    ctxRef?.ui.setWidget("btrix:firstrun", undefined);
    ctxRef?.ui.setStatus("btrix-replay", undefined);
    ctxRef?.ui.setStatus("btrix", undefined);
    ctxRef?.ui.setTitle("pi");
    monitor.dispose();
    // Crawls are left running on purpose; replay servers and the scratch
    // browser are not.
    await Promise.all([servers.closeAll(), browser.stop()]);
    ctxRef = undefined;
  });
}
