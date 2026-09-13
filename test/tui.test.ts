/**
 * Fitting lines to the terminal.
 *
 * pi throws on a component that renders wider than the viewport, which is what
 * happened in use: a coloured line was passed through untruncated and crashed
 * the session. So the property under test is simply that nothing ever exceeds
 * the width it was given.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ellipsis, linesComponent } from "../src/tui.ts";

const ESC = "\u001b";
const colour = (s: string) => `${ESC}[38;2;70;130;220m${s}${ESC}[0m`;
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const LONG_URL = "https://replayweb.page/?source=http://localhost:8087/stanford-news.wacz";

describe("linesComponent", () => {
  it("never renders wider than the width it is given", () => {
    // The original bug: colour meant the line skipped the width check.
    const lines = [
      colour(LONG_URL),
      "  sulnews  library.stanford.edu/news  collection stanford-news · prefix · limit 25 · behavior load-more.js",
      colour("short"),
      "",
    ];
    for (const width of [40, 60, 80, 100, 120]) {
      for (const mode of ["wrap", "clip"] as const) {
        const rendered = linesComponent(lines, { overflow: mode }).render(width);
        for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("is not affected by being called twice", () => {
    // A global regex used with .test() keeps its lastIndex, so the old code
    // gave different answers on identical input.
    const component = linesComponent([colour(LONG_URL)]);
    const first = component.render(60);
    const second = component.render(60);
    expect(second).toEqual(first);
  });

  it("wraps rather than losing a url someone has to copy", () => {
    const rendered = linesComponent([colour(LONG_URL)]).render(40);
    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.map(strip).join("")).toBe(LONG_URL);
  });

  it("clips instead of wrapping for the widget, keeping its height fixed", () => {
    const rendered = linesComponent([colour(LONG_URL)], { overflow: "clip" }).render(40);
    expect(rendered).toHaveLength(1);
    expect(visibleWidth(rendered[0]!)).toBeLessThanOrEqual(40);
  });

  it("counts the indent against the width", () => {
    const rendered = linesComponent(["x".repeat(50)], { indent: "      " }).render(40);
    for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(rendered[0]!.startsWith("      ")).toBe(true);
  });

  it("leaves short lines exactly as they are", () => {
    const lines = ["a", colour("b"), ""];
    expect(linesComponent(lines).render(80)).toEqual(lines);
  });

  it("survives a viewport too narrow to be useful", () => {
    for (const line of linesComponent([colour(LONG_URL)]).render(4)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(8);
    }
  });
});

describe("ellipsis", () => {
  it("measures columns, not characters", () => {
    const wide = colour("x".repeat(30));
    expect(visibleWidth(ellipsis(wide, 10))).toBeLessThanOrEqual(10);
    // Already short enough: returned untouched.
    expect(ellipsis(colour("ok"), 10)).toBe(colour("ok"));
  });
});
