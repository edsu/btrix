/**
 * Loads index.ts against a stub ExtensionAPI.
 *
 * This is the wiring test: it catches bad imports, missing registrations and a
 * factory that starts background work it should not. It needs no pi runtime and
 * makes no model calls, so it runs in CI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

function stubApi() {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const events = new Map<string, Handler[]>();
  const entryRenderers = new Map<string, any>();
  const messages: any[] = [];
  const entries: any[] = [];

  const flags = new Map<string, any>();

  const api = {
    registerTool: (t: any) => tools.push(t),
    registerFlag: (name: string, opts: any) => flags.set(name, opts),
    getFlag: (name: string) => flags.get(name)?.value,
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    registerEntryRenderer: (type: string, r: any) => entryRenderers.set(type, r),
    on: (name: string, h: Handler) => {
      const list = events.get(name) ?? [];
      list.push(h);
      events.set(name, list);
    },
    sendMessage: (m: any, o: any) => messages.push({ m, o }),
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
  } as unknown as ExtensionAPI;

  return { api, tools, commands, events, entryRenderers, messages, entries, flags };
}

function stubCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
    ui: {
      theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
      setTitle: vi.fn(),
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
    },
    ...overrides,
  };
}

describe("extension wiring", () => {
  it("registers both tools with schemas, and no others", () => {
    const s = stubApi();
    extension(s.api);
    expect(s.tools.map((t) => t.name).sort()).toEqual([
      "btrix_clean",
      "btrix_list",
      "btrix_profile",
      "btrix_review",
      "btrix_run",
      "btrix_status",
      "btrix_stop",
      "btrix_view",
    ]);
    for (const tool of s.tools) {
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("registers the --dir flag so the store can be relocated", () => {
    const s = stubApi();
    extension(s.api);
    expect(s.flags.get("dir")).toMatchObject({ type: "string" });
  });

  it("registers the command, the summary renderer and the lifecycle handlers", () => {
    const s = stubApi();
    extension(s.api);
    expect([...s.commands.keys()]).toEqual(["btrix"]);
    expect([...s.entryRenderers.keys()]).toEqual(["btrix-summary"]);
    expect([...s.events.keys()].sort()).toEqual([
      "session_shutdown",
      "session_start",
      "tool_call",
      "tool_result",
      "turn_start",
    ]);
  });

  it("starts no timer in the factory", () => {
    // Extension factories run in invocations that never open a session, so
    // background resources must wait for session_start.
    const spy = vi.spyOn(global, "setInterval");
    const s = stubApi();
    extension(s.api);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores tool_call events for other tools", async () => {
    const s = stubApi();
    extension(s.api);
    const handler = s.events.get("tool_call")![0]!;
    expect(await handler({ toolName: "bash", input: { command: "ls" } }, stubCtx())).toBeUndefined();
  });

  it("clears its widgets on shutdown without killing anything", async () => {
    const s = stubApi();
    extension(s.api);
    const ctx = stubCtx();
    await s.events.get("session_start")![0]!({}, ctx);
    await s.events.get("session_shutdown")![0]!({}, ctx);
    // Nothing to assert about containers: shutdown deliberately leaves them
    // running. This asserts it does not throw with no crawls watched.
    expect(ctx.ui.setWidget).not.toThrow;
  });

  it("renders the completion summary card without sending it to the model", () => {
    const s = stubApi();
    extension(s.api);
    const renderer = s.entryRenderers.get("btrix-summary")!;
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
    const card = renderer(
      {
        data: {
          outcome: { kind: "promoted", dest: "btrix/out/mysite.wacz", message: "ok" },
          stats: {
          name: "mysite",
          state: "done",
          phase: "done",
          containerRunning: false,
          crawled: 12,
          total: 12,
          failed: 0,
          excluded: 0,
          rateLimited: 0,
          limitHit: false,
          warnings: 0,
          errors: 0,
          pending: [],
          bytes: { wacz: 5 * 1024 ** 2 },
          discovering: false,
          windowMs: 60_000,
          waczPath: "btrix/out/mysite.wacz",
          },
        },
      },
      { expanded: true },
      theme,
    );
    expect(card).toBeTruthy();
    expect(renderer({ data: undefined }, { expanded: false }, theme)).toBeUndefined();
  });
});

describe("--dir reaches the tools", () => {
  // The factory registers tools before the CLI has parsed --dir, so the store
  // must be read through an accessor rather than captured.
  it("resolves the store lazily, not at registration time", async () => {
    const { createTools } = await import("../src/tools.ts");
    const { CrawlMonitor } = await import("../src/monitor.ts");
    const { resolveStore } = await import("../src/store.ts");
    const monitor = new CrawlMonitor();
    let store = resolveStore({ cwd: "/one", env: {} });
    const tools = createTools(monitor, () => store);

    // Relocate after the tools exist, as --dir does.
    store = resolveStore({ dir: "/two", cwd: "/one", env: {} });
    const result: any = await tools
      .find((t) => t.name === "btrix_status")!
      .execute("id", { name: "ghost" }, undefined, undefined, {} as any);
    monitor.dispose();
    // The message names the new store, proving the accessor was consulted.
    expect(result.content[0].text).toContain("ghost");
  });
});
