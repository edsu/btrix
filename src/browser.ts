/**
 * A scratch browser for writing custom behaviors.
 *
 * Authoring a behavior otherwise means a full crawl per iteration: start a
 * container, wait, read the logs, guess. This keeps a real browser open on the
 * page so selectors can be tried against it directly.
 *
 * Two kinds. Local Chrome is the nicer one to work in — a native window, real
 * DevTools on F12, nothing to start — and is the default. The container's
 * browser is the exact one the crawler runs, which is worth having when a
 * selector works locally and still fails in a crawl.
 *
 * Session-scoped either way. A crawl is detached because it should outlive the
 * session; a stray browser should not.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type CdpTarget, evaluate, navigate, pageInfo } from "./cdp.ts";
import { killContainers, stopContainers } from "./engine.ts";
import { launchChrome, type LocalChrome } from "./localchrome.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_SH = path.join(HERE, "..", "scripts", "browser.sh");

/** noVNC, where the container's browser can be watched and clicked. */
export const VNC_PORT = 6080;
const READY_TIMEOUT_MS = 180_000;

export type BrowserKind = "local" | "container";

export interface OpenResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  kind?: BrowserKind;
  /** Where to watch it, for the container browser. */
  vnc?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ScratchBrowser {
  /** Named per process, so two btrix sessions do not fight over one container. */
  readonly container = `btrix-browser-${process.pid}`;
  private kind: BrowserKind | undefined;
  private local: LocalChrome | undefined;

  /** Where a local browser's throwaway profile lives, read when it is needed. */
  constructor(private readonly profileDir: () => string) {}

  isRunning(): boolean {
    return this.kind !== undefined;
  }

  runningKind(): BrowserKind | undefined {
    return this.kind;
  }

  vncUrl(): string {
    return `http://localhost:${VNC_PORT}/`;
  }

  private target(): CdpTarget | undefined {
    if (this.kind === "local" && this.local) return { port: this.local.port };
    if (this.kind === "container") return { container: this.container };
    return undefined;
  }

  /**
   * Open `url`, or navigate an already-running browser. Resolves once the page
   * answers — which on a first container run includes an image pull.
   */
  async open(url: string, opts: { kind?: BrowserKind } = {}, onProgress?: (note: string) => void): Promise<OpenResult> {
    const wanted = opts.kind ?? "local";

    // Already have one of the right kind: just move it.
    if (this.kind === wanted) {
      const moved = await navigate(this.target()!, url);
      return { ...moved, kind: this.kind, vnc: this.kind === "container" ? this.vncUrl() : undefined };
    }
    // A different kind was asked for, so close the old one first.
    if (this.kind) await this.stop();

    return wanted === "local" ? this.openLocal(url, onProgress) : this.openContainer(url, onProgress);
  }

  private async openLocal(url: string, onProgress?: (note: string) => void): Promise<OpenResult> {
    onProgress?.("starting a local browser…");
    const started = await launchChrome(this.profileDir(), url);
    if ("error" in started) return { ok: false, error: started.error };

    this.local = started;
    this.kind = "local";

    // Chrome reports its port before the page has finished loading.
    const deadline = Date.now() + 20_000;
    let last = "the browser did not answer";
    while (Date.now() < deadline) {
      const info = await pageInfo({ port: started.port });
      if (info.ok) return { ok: true, url: info.url, title: info.title, kind: "local" };
      last = info.error ?? last;
      await sleep(500);
    }
    return { ok: false, error: last };
  }

  private async openContainer(url: string, onProgress?: (note: string) => void): Promise<OpenResult> {
    const child = spawn("bash", [BROWSER_SH, this.container, url], { detached: true, stdio: "ignore" });
    child.unref();
    this.kind = "container";

    onProgress?.("starting the crawler's browser (this pulls the image the first time)…");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = "the browser did not become ready";
    while (Date.now() < deadline) {
      await sleep(2_000);
      const info = await pageInfo({ container: this.container });
      if (info.ok) return { ok: true, url: info.url, title: info.title, kind: "container", vnc: this.vncUrl() };
      last = info.error ?? last;
    }
    return { ok: false, error: last };
  }

  /** Evaluate in the open page. */
  async eval(expression: string) {
    const target = this.target();
    if (!target) return { ok: false, error: "no browser is running", console: [] as string[] };
    return evaluate(target, expression);
  }

  async info() {
    const target = this.target();
    if (!target) return { ok: false, error: "no browser is running", console: [] as string[] };
    return pageInfo(target);
  }

  /** Stop it. Graceful first, since a browser writes a profile directory. */
  async stop(): Promise<void> {
    const kind = this.kind;
    this.kind = undefined;
    if (kind === "local") {
      this.local?.process.kill();
      this.local = undefined;
      return;
    }
    if (kind === "container") {
      const stopped = await stopContainers([this.container], 5);
      if (!stopped) await killContainers([this.container]);
    }
  }
}
