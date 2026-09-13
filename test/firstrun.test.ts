/**
 * First-run auth detection.
 */

import { describe, expect, it } from "vitest";
import { type AuthProbe, firstRunPanel, probeAuth, readyHeader } from "../src/firstrun.ts";

const probe = (models: { provider: string; id: string }[], authed: string[]): AuthProbe => ({
  getAvailable: () => models,
  hasConfiguredAuth: (m) => authed.includes(m.provider),
});

describe("probeAuth", () => {
  it("is not ready when no model has credentials", () => {
    const state = probeAuth(probe([{ provider: "anthropic", id: "claude-sonnet-4-6" }], []));
    expect(state.ready).toBe(false);
    expect(state.model).toBeUndefined();
    expect(state.unauthenticated).toEqual(["anthropic"]);
  });

  it("picks whichever provider the user actually signed into", () => {
    // A subscription login could be any provider, so assuming Anthropic would
    // be wrong for most people.
    const state = probeAuth(
      probe(
        [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "openai", id: "gpt-5" },
        ],
        ["openai"],
      ),
    );
    expect(state.ready).toBe(true);
    expect(state.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(state.unauthenticated).toEqual(["anthropic"]);
  });

  it("survives a registry that throws or returns nothing", () => {
    expect(
      probeAuth({
        getAvailable: () => {
          throw new Error("catalogue unavailable");
        },
        hasConfiguredAuth: () => true,
      }).ready,
    ).toBe(false);

    expect(probeAuth({ getAvailable: () => [], hasConfiguredAuth: () => true }).ready).toBe(false);

    // A registry that throws per model must not be read as authenticated.
    expect(
      probeAuth({
        getAvailable: () => [{ provider: "x", id: "y" }],
        hasConfiguredAuth: () => {
          throw new Error("no");
        },
      }).ready,
    ).toBe(false);
  });
});

describe("firstRunPanel", () => {
  it("says nothing when credentials are already present", () => {
    expect(firstRunPanel(probeAuth(probe([{ provider: "anthropic", id: "a" }], ["anthropic"])))).toEqual([]);
  });

  it("names /login and an API key, without naming the runtime", () => {
    const lines = firstRunPanel(probeAuth(probe([{ provider: "anthropic", id: "a" }], []))).join("\n");
    expect(lines).toContain("/login");
    expect(lines).toContain("ANTHROPIC_API_KEY");
    // The point of the panel is that the user need not know what pi is.
    // Word-boundary matched: "api key" legitimately contains the letters.
    expect(lines.toLowerCase()).not.toMatch(/\bpi\b/);
    expect(lines).not.toContain("node_modules");
    // Crawling is local and needs no account; say so, since "log in" invites
    // the worry that archives are being uploaded.
    expect(lines).toContain("Crawling itself runs locally");
  });
});

describe("readyHeader", () => {
  it("names the store and the model in use", () => {
    const state = probeAuth(probe([{ provider: "openai", id: "gpt-5" }], ["openai"]));
    expect(readyHeader(state, "/w/btrix")[1]).toBe("store /w/btrix · openai/gpt-5");
  });
});
