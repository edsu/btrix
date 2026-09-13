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
import { notifyDesktop } from "./src/notify.ts";
import { renderForModel, renderInventory, renderWidget, startupLines } from "./src/render.ts";
import { ReplayServers } from "./src/serve.ts";
import { humanBytes } from "./src/sizes.ts";
import type { CrawlStats } from "./src/stats.ts";
import { activeRun, collectionFor, legacyRoot, resolveStore, type Store } from "./src/store.ts";
import { engineStatus } from "./src/engine.ts";
import { firstRunPanel, probeAuth, readyHeader } from "./src/firstrun.ts";
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
      ctx.ui.setWidget(widgetKey(target.config), renderWidget(stats, ctx.ui.theme));

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

    // Someone who installed btrix has not necessarily heard of pi, and with no
    // credentials the runtime's own message names itself and a node_modules
    // path. Get in front of that with something actionable.
    const auth = probeAuth(ctx.modelRegistry as never);
    if (ctx.hasUI) {
      if (!auth.ready) {
        ctx.ui.setWidget("btrix:firstrun", firstRunPanel(auth), { placement: "belowEditor" });
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

    if (ctx.hasUI && auth.ready) {
      ctx.ui.setStatus("btrix", ctx.ui.theme.fg("dim", readyHeader(auth, store.root)[1] ?? ""));

      // Orient the user in three lines, without spending a turn on it. The
      // engine check is the important one: finding out that Docker is absent
      // or asleep here beats finding out several minutes into an image pull.
      const [engine, inv] = await Promise.all([engineStatus(), buildInventory(store, legacy)]);
      ctx.ui.setWidget(
        "btrix:startup",
        startupLines({ inv, engine, model: readyHeader(auth, store.root)[1], adopted: adopted.map((t) => t.config) }, ctx.ui.theme),
      );
    }
  });

  // Confirmation gate. pi ships no permission system by design, so anything
  // worth a prompt is ours to ask.
  pi.on("turn_start", async (_event, ctx) => {
    // The user may have run /login since startup.
    if (ctx.hasUI && probeAuth(ctx.modelRegistry as never).ready) {
      ctx.ui.setWidget("btrix:firstrun", undefined);
    }
    // The startup summary has done its job once work begins; the rows are
    // better spent on the transcript.
    ctx.ui.setWidget("btrix:startup", undefined);
    return undefined;
  });

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
    ctxRef?.ui.setWidget("btrix:firstrun", undefined);
    ctxRef?.ui.setWidget("btrix:startup", undefined);
    ctxRef?.ui.setStatus("btrix-replay", undefined);
    ctxRef?.ui.setStatus("btrix", undefined);
    ctxRef?.ui.setTitle("pi");
    monitor.dispose();
    // Crawls are left running on purpose; replay servers are not.
    await servers.closeAll();
    ctxRef = undefined;
  });
}
