/**
 * Terminal notifications. The interesting cases are the terminals we must stay
 * quiet in, and text that would break out of the escape sequence.
 */

import { describe, expect, it } from "vitest";
import { detectProtocol, encode, notifyDesktop } from "../src/notify.ts";

const ESC = "\u001b";
const BEL = "\u0007";

describe("detectProtocol", () => {
  it("recognises kitty and the OSC 777 family", () => {
    expect(detectProtocol({ TERM: "xterm-kitty" })).toBe("osc99");
    expect(detectProtocol({ KITTY_WINDOW_ID: "1" })).toBe("osc99");
    expect(detectProtocol({ TERM_PROGRAM: "ghostty" })).toBe("osc777");
    expect(detectProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("osc777");
    expect(detectProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("osc777");
    expect(detectProtocol({ TERM: "rxvt-unicode-256color" })).toBe("osc777");
  });

  it("stays quiet in a terminal it does not recognise", () => {
    // Writing escape sequences blind can print gibberish into the transcript,
    // which is worse than having no notification at all.
    expect(detectProtocol({ TERM: "dumb" })).toBe("none");
    expect(detectProtocol({})).toBe("none");
    expect(encode("none", "a", "b")).toBeUndefined();
    expect(notifyDesktop("a", "b", { TERM: "dumb" })).toBe(false);
  });
});

describe("encode", () => {
  it("wraps title and body in the right sequence", () => {
    const osc777 = encode("osc777", "Crawl finished", "25 pages")!;
    expect(osc777).toBe(`${ESC}]777;notify;Crawl finished;25 pages${BEL}`);

    const osc99 = encode("osc99", "Crawl finished", "25 pages")!;
    expect(osc99).toContain(`${ESC}]99;i=1:d=0;Crawl finished`);
    expect(osc99).toContain("i=1:p=body;25 pages");
  });

  it("neutralises characters that would end the sequence early", () => {
    // A collection name is user-supplied, so it can contain anything.
    const out = encode("osc777", "a;b", `line${ESC}[31m;x`)!;
    const payload = out.slice(`${ESC}]777;notify;`.length, -1);

    // Exactly one semicolon should survive: the separator between title and
    // body. Any injected one would add a field and corrupt the sequence.
    const fields = payload.split(";");
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBe("a b");
    expect(fields[1]).not.toContain(ESC);
    expect(fields[1]).not.toContain("\\");
  });
});
