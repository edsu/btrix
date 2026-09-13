/**
 * A scratch browser for writing custom behaviors.
 *
 * Authoring a behavior otherwise means a full crawl per iteration: start a
 * container, wait, read the logs, guess. This keeps a real Chrome open on the
 * page so selectors can be tried against it directly, with noVNC to watch what
 * happens.
 *
 * Session-scoped on purpose. A crawl is detached because it should outlive the
 * session; a stray Chrome should not.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, navigate, pageInfo } from "./cdp.ts";
import { killContainers, stopContainers } from "./engine.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_SH = path.join(HERE, "..", "scripts", "browser.sh");

/** noVNC, where a person can watch and click. */
export const VNC_PORT = 6080;
const READY_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ScratchBrowser {
  /** Named per process, so two btrix sessions do not fight over one container. */
  readonly container = `btrix-browser-${process.pid}`;
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  vncUrl(): string {
    return `http://localhost:${VNC_PORT}/`;
  }

  /**
   * Start the browser on `url`, or navigate an already-running one. Resolves
   * once the page answers, which on a first run includes an image pull.
   */
  async open(url: string, onProgress?: (note: string) => void): Promise<{ ok: boolean; error?: string; url?: string; title?: string }> {
    if (this.running) {
      const moved = await navigate(this.container, url);
      return { ok: moved.ok, error: moved.error, url: moved.url, title: moved.title };
    }

    const child = spawn("bash", [BROWSER_SH, this.container, url], { detached: true, stdio: "ignore" });
    child.unref();
    this.running = true;

    onProgress?.("starting a browser (this pulls the crawler image the first time)…");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = "the browser did not become ready";
    while (Date.now() < deadline) {
      await sleep(2_000);
      const info = await pageInfo(this.container);
      if (info.ok) return { ok: true, url: info.url, title: info.title };
      lastError = info.error ?? lastError;
    }
    return { ok: false, error: lastError };
  }

  /** Evaluate in the open page. */
  async eval(expression: string): Promise<ReturnType<typeof evaluate> extends Promise<infer T> ? T : never> {
    return evaluate(this.container, expression);
  }

  async info(): Promise<ReturnType<typeof pageInfo> extends Promise<infer T> ? T : never> {
    return pageInfo(this.container);
  }

  /** Stop it. Graceful first, since Chrome writes a profile directory. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const stopped = await stopContainers([this.container], 5);
    if (!stopped) await killContainers([this.container]);
  }
}
