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
import { CrawlMonitor } from "./src/monitor.ts";
import { renderForModel, renderWidget } from "./src/render.ts";
import { humanBytes } from "./src/sizes.ts";
import type { CrawlStats } from "./src/stats.ts";
import { createTools } from "./src/tools.ts";

/** Free space below which starting a crawl is worth a confirmation. */
const LOW_DISK_BYTES = 5 * 1024 ** 3;

const widgetKey = (name: string) => `btrix:${name}`;

export default function (pi: ExtensionAPI) {
  // Constructing the monitor starts nothing: its timer only begins on the
  // first watch(), which happens in session_start or a tool call. Extension
  // factories can run in invocations that never open a session, so background
  // resources must not be started here.
  const cwd = process.cwd();
  let ctxRef: ExtensionContext | undefined;

  const monitor = new CrawlMonitor({
    cwd,
    intervalMs: 1_000,
    onTick(stats) {
      const ctx = ctxRef;
      if (!ctx?.hasUI) return;
      ctx.ui.setWidget(widgetKey(stats.name), renderWidget(stats, ctx.ui.theme));
    },
    onComplete(stats) {
      const ctx = ctxRef;
      // Clear the live widget; the durable card takes over.
      ctx?.ui.setWidget(widgetKey(stats.name), undefined);

      // Human-facing summary. Custom entries do not enter LLM context, so
      // this costs nothing.
      pi.appendEntry<CrawlStats>("btrix-summary", stats);

      // One message, one turn: the model announces the result and can offer
      // a review. This replaces Claude Code's background-task completion
      // notification, which is what the old run skill relied on.
      pi.sendMessage(
        {
          customType: "btrix",
          content:
            stats.state === "done"
              ? `The ${stats.name} crawl finished. ${renderForModel(stats)}`
              : `The ${stats.name} crawl ended without producing a WACZ. ${renderForModel(stats)}`,
          display: false,
          details: stats,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  for (const tool of createTools(monitor, cwd)) pi.registerTool(tool);

  pi.registerEntryRenderer<CrawlStats>("btrix-summary", (entry, { expanded }, theme) => {
    const s = entry.data;
    if (!s) return undefined;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    const ok = s.state === "done";
    const size = s.bytes.wacz ?? s.bytes.archive;
    box.addChild(
      new Text(
        `${theme.fg(ok ? "success" : "warning", ok ? "✓ crawl finished" : "⚠ crawl ended early")} ` +
          `${theme.fg("text", s.name)} ${theme.fg("dim", `${s.crawled}/${s.total} pages · ${humanBytes(size)}`)}`,
        0,
        0,
      ),
    );
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", renderForModel(s)), 0, 0));
      if (s.waczPath) box.addChild(new Text(theme.fg("mdLink", s.waczPath), 0, 0));
    }
    return box;
  });

  /** Manual readout, rendered for the human without involving the model. */
  pi.registerCommand("btrix", {
    description: "Show Browsertrix crawl progress in the widget (no model turn)",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const name = args.trim();
      if (name) monitor.watch(name);
      else if ((await monitor.adoptRunning()).length === 0 && monitor.watched().length === 0) {
        ctx.ui.notify("No crawl is running. Start one with btrix_run.", "info");
        return;
      }
      await monitor.tick();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    // State lives on disk, not in the session: a crawl started in another
    // session, or by hand, is picked up here and gets a widget.
    const adopted = await monitor.adoptRunning();
    if (adopted.length) {
      await monitor.tick();
      if (ctx.hasUI) ctx.ui.notify(`btrix: watching ${adopted.join(", ")}`, "info");
    }
  });

  // Confirmation gate. pi ships no permission system by design, so anything
  // worth a prompt is ours to ask.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "btrix_run") return undefined;
    const stats = await monitor
      .stats(String((event.input as { config?: unknown }).config ?? ""))
      .catch(() => undefined);
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
    for (const name of monitor.watched()) ctxRef?.ui.setWidget(widgetKey(name), undefined);
    monitor.dispose();
    ctxRef = undefined;
  });
}
