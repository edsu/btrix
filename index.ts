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

import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { finishRun, type Outcome } from "./src/finish.ts";
import { CrawlMonitor, type WatchTarget } from "./src/monitor.ts";
import { renderForModel, renderInventory, renderWidget } from "./src/render.ts";
import { ReplayServers } from "./src/serve.ts";
import { humanBytes } from "./src/sizes.ts";
import type { CrawlStats } from "./src/stats.ts";
import { activeRun, collectionFor, legacyRoot, resolveStore, type Store } from "./src/store.ts";
import { buildInventory } from "./src/inventory.ts";
import { configPath, createTools, listConfigs } from "./src/tools.ts";

/** Free space below which starting a crawl is worth a confirmation. */
const LOW_DISK_BYTES = 5 * 1024 ** 3;

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
  // Resolved once the CLI has parsed --dir, at session_start.
  let store: Store = resolveStore({ cwd });
  let legacy = legacyRoot(cwd);
  let ctxRef: ExtensionContext | undefined;

  const monitor = new CrawlMonitor({
    intervalMs: 1_000,
    onTick(stats, target) {
      const ctx = ctxRef;
      if (!ctx?.hasUI) return;
      ctx.ui.setWidget(widgetKey(target.config), renderWidget(stats, ctx.ui.theme));
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

  for (const tool of createTools(
    monitor,
    () => store,
    () => legacy,
    servers,
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
        monitor.watch(target);
        await monitor.tick();
        return;
      }

      await monitor.adoptRunning(targetFor);
      await monitor.tick();
      // Nothing live to watch: show the inventory instead of an empty widget.
      // Rendered here, so asking "what do I have?" costs no model turn.
      if (monitor.watched().length === 0) {
        const inv = await buildInventory(store, legacy);
        ctx.ui.setWidget("btrix:inventory", renderInventory(inv, ctx.ui.theme), { placement: "belowEditor" });
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;

    // --dir is only available once the CLI has parsed it.
    const flag = pi.getFlag("dir");
    store = resolveStore({ dir: typeof flag === "string" ? flag : undefined, cwd: ctx.cwd ?? cwd });
    legacy = legacyRoot(ctx.cwd ?? cwd);

    // State lives on disk, not in the session: a crawl started in another
    // session, or by hand, is picked up here and gets a widget.
    const adopted = await monitor.adoptRunning(targetFor);
    if (adopted.length) {
      await monitor.tick();
      if (ctx.hasUI) ctx.ui.notify(`btrix: watching ${adopted.map((t) => t.config).join(", ")}`, "info");
    } else if (ctx.hasUI && store.source === "default" && listConfigs(store).length === 0) {
      ctx.ui.notify(`btrix: no crawls here yet. A store will be created at ${store.root} when you start one.`, "info");
    }
  });

  // Confirmation gate. pi ships no permission system by design, so anything
  // worth a prompt is ours to ask.
  pi.on("tool_result", async (_event, ctx) => {
    const live = servers.running();
    if (live.length && ctx.hasUI) {
      ctx.ui.setStatus("btrix-replay", ctx.ui.theme.fg("dim", `replay :${live.map((s) => s.port).join(",")}`));
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "btrix_run") return undefined;
    const config = String((event.input as { config?: unknown }).config ?? "");
    const target = targetFor(config);
    const stats = target ? await monitor.stats(target).catch(() => undefined) : undefined;
    const free = stats?.free;
    if (free !== undefined && free < LOW_DISK_BYTES) {
      const msg = `Only ${humanBytes(free)} free. Browsertrix aborts outright when the disk fills mid-crawl.`;
      if (!ctx.hasUI) return { block: true, reason: msg };
      if (!(await ctx.ui.confirm("Low disk space", `${msg}\n\nStart the crawl anyway?`))) {
        return { block: true, reason: "Blocked: not enough free disk space" };
      }
    }
    return undefined;
  });

  // Idempotent: stop rendering, but leave the containers running. A detached
  // crawl outliving the session is the point.
  pi.on("session_shutdown", async () => {
    for (const target of monitor.watched()) ctxRef?.ui.setWidget(widgetKey(target.config), undefined);
    ctxRef?.ui.setWidget("btrix:inventory", undefined);
    ctxRef?.ui.setStatus("btrix-replay", undefined);
    monitor.dispose();
    // Crawls are left running on purpose; replay servers are not.
    await servers.closeAll();
    ctxRef = undefined;
  });
}
