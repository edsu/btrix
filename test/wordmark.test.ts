/**
 * The startup wordmark. A random colour each start is pleasant; a wordmark that
 * prints escape codes as literal text, or that breaks the layout beside it, is
 * not — so those are what is tested.
 */

import { describe, expect, it } from "vitest";
import {
  colourWordmark,
  pickScheme,
  SCHEMES,
  supportsTruecolor,
  WORDMARK,
  wordmarkLines,
} from "../src/wordmark.ts";

const ESC = "\u001b";
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("WORDMARK", () => {
  it("is pure ASCII, so it needs no fallback for a non-utf8 locale", () => {
    for (const line of WORDMARK) expect(line).toMatch(/^[\x20-\x7e]*$/);
  });

  it("is four lines of even width", () => {
    expect(WORDMARK).toHaveLength(4);
    expect(Math.max(...WORDMARK.map((l) => l.length))).toBe(24);
  });
});

describe("colourWordmark", () => {
  it("emits real escape sequences, not their text", () => {
    // The introducer went missing once, which prints the codes as garbage.
    const out = colourWordmark(WORDMARK, SCHEMES[0]!);
    expect(out[1]).toContain(`${ESC}[38;2;`);
    expect(out[1]).toContain(`${ESC}[0m`);
  });

  it("does not change the visible width, so the layout beside it still lines up", () => {
    for (const scheme of SCHEMES) {
      const out = colourWordmark(WORDMARK, scheme);
      out.forEach((line, i) => expect(strip(line)).toBe(WORDMARK[i]));
    }
  });

  it("leaves spaces uncoloured, keeping escapes off the padding", () => {
    const out = colourWordmark(["ab  cd"], SCHEMES[0]!);
    // A reset lands before the run of spaces rather than colouring them.
    expect(out[0]).toContain(`${ESC}[0m  `);
  });

  it("runs the gradient from one end to the other", () => {
    const scheme = {
      name: "t",
      from: [0, 0, 0] as [number, number, number],
      to: [255, 255, 255] as [number, number, number],
    };
    const line = colourWordmark(["####################"], scheme)[0]!;
    expect(line).toContain("38;2;0;0;0");
    expect(line).toContain("38;2;255;255;255");
  });
});

describe("pickScheme", () => {
  it("varies with the source of randomness", () => {
    expect(pickScheme(() => 0).name).toBe(SCHEMES[0]!.name);
    expect(pickScheme(() => 0.999).name).toBe(SCHEMES[SCHEMES.length - 1]!.name);
  });

  it("stays in range at the boundaries", () => {
    // Math.random() can return exactly 0, and a sloppy floor can overrun at 1.
    for (const r of [0, 0.5, 0.9999999, 1]) expect(SCHEMES).toContain(pickScheme(() => r));
  });
});

describe("supportsTruecolor", () => {
  it("trusts COLORTERM and known terminals", () => {
    expect(supportsTruecolor({ COLORTERM: "truecolor" })).toBe(true);
    expect(supportsTruecolor({ COLORTERM: "24bit" })).toBe(true);
    expect(supportsTruecolor({ TERM_PROGRAM: "Ghostty" })).toBe(true);
  });

  it("does not assume it otherwise", () => {
    expect(supportsTruecolor({ TERM: "xterm-256color" })).toBe(false);
    expect(supportsTruecolor({})).toBe(false);
  });
});

describe("wordmarkLines", () => {
  it("colours when it can, and reports which scheme it used", () => {
    const { lines, scheme } = wordmarkLines({ truecolor: true, random: () => 0 });
    expect(scheme?.name).toBe(SCHEMES[0]!.name);
    expect(lines[1]).toContain(ESC);
  });

  it("hands the plain wordmark to the theme when truecolor is unavailable", () => {
    const { lines, scheme } = wordmarkLines({ truecolor: false, plain: (l) => `<${l}>` });
    expect(scheme).toBeUndefined();
    expect(lines[0]).toBe(`<${WORDMARK[0]}>`);
    // No raw escapes of our own: whatever the theme emits is the theme's business.
    expect(lines.join("")).not.toContain(`${ESC}[38;2;`);
  });
});
