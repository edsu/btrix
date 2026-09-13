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
import type { CrawlMonitor } from "./monitor.ts";
import { renderForModel } from "./render.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_SH = path.join(HERE, "..", "scripts", "run.sh");

/** How long to wait for the image pull and first log output before returning. */
const STARTUP_TIMEOUT_MS = 180_000;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** Accept "sulnews", "sulnews.yaml" or "sulnews.yml" alike. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\.ya?ml$/, "");
}

export function configPath(cwd: string, name: string): string | undefined {
  for (const ext of [".yaml", ".yml"]) {
    const p = path.join(cwd, "config", `${name}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export function listConfigs(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, "config"))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createTools(monitor: CrawlMonitor, cwd: string): ToolDefinition<any, any, any>[] {
  const runTool = defineTool({
    name: "btrix_run",
    label: "Crawl",
    description:
      "Start a Browsertrix Crawler crawl for a config in ./config. Returns once the crawler is up and " +
      "reporting; the crawl itself keeps running in the background, detached, and survives this session. " +
      "Progress is shown continuously in the TUI widget, so do not poll for it.",
    promptSnippet: "Start a Browsertrix crawl for a named config",
    parameters: Type.Object({
      config: Type.String({ description: "Config name in ./config, without the .yaml extension" }),
    }),
    async execute(_id, params, signal, onUpdate) {
      const name = normalizeName(String(params.config));

      if (!configPath(cwd, name)) {
        const available = listConfigs(cwd);
        return text(
          `No config/${name}.yaml in ${cwd}.` +
            (available.length ? ` Available configs: ${available.join(", ")}` : " There are no configs yet."),
        );
      }

      if (await isCrawlRunning(name)) {
        monitor.watch(name);
        return text(`A crawl for ${name} is already running. Its progress is in the widget.`);
      }

      // Detached, with its own stdio, so the crawl outlives this session.
      fs.mkdirSync(path.join(cwd, ".btrix"), { recursive: true });
      const logPath = path.join(cwd, ".btrix", `run-${name}.log`);
      const out = fs.openSync(logPath, "a");
      const child = spawn("bash", [RUN_SH, name], {
        cwd,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      fs.closeSync(out);
      monitor.watch(name);

      let exited: number | null | undefined;
      child.on("exit", (code) => {
        exited = code;
      });

      // Wait out the image pull and the first statistics line. This window is
      // what the tool's AbortSignal cancels; after it, the crawl is on its own.
      onUpdate?.({ content: [{ type: "text", text: `pulling image and starting ${name}…` }], details: {} });
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let announcedContainer = false;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await killCrawl(name);
          return text(`Cancelled; stopped the ${name} crawl. Partial output is in collections/${name}/.`);
        }
        const stats = await monitor.stats(name);
        if (stats.crawled > 0 || stats.total > 0) {
          return {
            content: [{ type: "text", text: `Started ${name}. ${renderForModel(stats)}` }],
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

      const stats = await monitor.stats(name);
      return {
        content: [
          {
            type: "text",
            text:
              `Started ${name}, but it has not reported statistics within ` +
              `${Math.round(STARTUP_TIMEOUT_MS / 1000)}s. ${renderForModel(stats)}\n` +
              `Runner output: ${logPath}`,
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
        Type.String({ description: "Collection name. Defaults to the only running or watched crawl." }),
      ),
    }),
    async execute(_id, params) {
      let name = params.name ? String(params.name) : undefined;
      if (!name) {
        const running = (await runningCrawls()).map((c) => c.config).filter((n): n is string => !!n);
        const candidates = running.length ? running : monitor.watched();
        if (candidates.length === 1) name = candidates[0];
        else if (candidates.length > 1) {
          return text(`Several crawls to choose from: ${candidates.join(", ")}. Ask for one by name.`);
        } else {
          return text("No crawl is running and none is being watched. Name a collection explicitly.");
        }
      }
      if (!fs.existsSync(path.join(cwd, "collections", name!))) {
        return text(`No collections/${name} in ${cwd}. It may not have been crawled yet.`);
      }
      const stats = await monitor.stats(name!);
      monitor.watch(name!);
      return { content: [{ type: "text", text: renderForModel(stats) }], details: stats };
    },
  });

  return [runTool, statusTool];
}
