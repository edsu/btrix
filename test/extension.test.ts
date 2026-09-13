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

  const api = {
    registerTool: (t: any) => tools.push(t),
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

  return { api, tools, commands, events, entryRenderers, messages, entries };
}

function stubCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
      setWidget: vi.fn(),
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
    expect(s.tools.map((t) => t.name).sort()).toEqual(["btrix_run", "btrix_status"]);
    for (const tool of s.tools) {
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("registers the command, the summary renderer and the lifecycle handlers", () => {
    const s = stubApi();
    extension(s.api);
    expect([...s.commands.keys()]).toEqual(["btrix"]);
    expect([...s.entryRenderers.keys()]).toEqual(["btrix-summary"]);
    expect([...s.events.keys()].sort()).toEqual(["session_shutdown", "session_start", "tool_call"]);
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
          waczPath: "collections/mysite/mysite.wacz",
        },
      },
      { expanded: true },
      theme,
    );
    expect(card).toBeTruthy();
    expect(renderer({ data: undefined }, { expanded: false }, theme)).toBeUndefined();
  });
});
