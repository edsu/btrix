/**
 * The replay server. ReplayWeb.page reads a .wacz by range-requesting the ZIP
 * central directory — including a *suffix* range to find the
 * end-of-central-directory record — so ranges are not optional garnish here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPLAY_ORIGIN, parseRange, serveDir, type ReplayServer } from "../src/serve.ts";

describe("parseRange", () => {
  it("handles a closed range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-20", 1000)).toEqual({ start: 10, end: 20 });
  });

  it("handles an open-ended range", () => {
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("handles the suffix form ReplayWeb.page uses to find the zip directory", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    // A suffix longer than the file is the whole file, not a negative offset.
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("clamps an end past the file", () => {
    expect(parseRange("bytes=990-99999", 1000)).toEqual({ start: 990, end: 999 });
  });

  it("rejects nonsense rather than serving the wrong bytes", () => {
    expect(parseRange("bytes=1000-", 1000)).toBeUndefined();
    expect(parseRange("bytes=50-10", 1000)).toBeUndefined();
    expect(parseRange("bytes=-", 1000)).toBeUndefined();
    expect(parseRange("bytes=-0", 1000)).toBeUndefined();
    expect(parseRange("items=0-10", 1000)).toBeUndefined();
    expect(parseRange("bytes=0-10, 20-30", 1000)).toBeUndefined();
  });
});

describe("serveDir", () => {
  let dir: string;
  let server: ReplayServer;
  const body = Buffer.from("0123456789".repeat(50)); // 500 bytes

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-serve-"));
    fs.writeFileSync(path.join(dir, "example.wacz"), body);
    server = await serveDir(dir, 18087);
  });
  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (file: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}/${file}`, { headers });

  it("serves the whole file with CORS and an Accept-Ranges advert", async () => {
    const res = await get("example.wacz");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(REPLAY_ORIGIN);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("application/wacz+zip");
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(500);
  });

  it("answers a suffix range with 206 and the right bytes", async () => {
    const res = await get("example.wacz", { Range: "bytes=-10" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 490-499/500");
    expect(await res.text()).toBe("0123456789");
  });

  it("answers a closed range", async () => {
    const res = await get("example.wacz", { Range: "bytes=0-4" });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("01234");
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const res = await get("example.wacz", { Range: "bytes=9999-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */500");
  });

  it("answers the preflight", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/example.wacz`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(REPLAY_ORIGIN);
  });

  it("does not allow every origin, so a stray tab cannot read an archive", async () => {
    // The loopback bind is not a boundary against the user's own browser.
    // Note this is enforced by the browser, not here: the bytes still go out,
    // and script on another origin is what gets refused them.
    const res = await get("example.wacz");
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("exposes the range headers, or the reader cannot see what it got", async () => {
    // Only the safelisted response headers reach script by default, and
    // Content-Range is not one of them.
    const res = await fetch(`http://127.0.0.1:${server.port}/example.wacz`, {
      headers: { Origin: REPLAY_ORIGIN, Range: "bytes=-100" },
    });
    expect(res.status).toBe(206);
    const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const h of ["content-range", "accept-ranges", "content-length"]) {
      expect(exposed, h).toContain(h);
    }
    expect(res.headers.get("content-range")).toBe("bytes 400-499/500");
  });

  it("allows whatever headers the preflight asks for", async () => {
    // Narrowing these bought nothing -- a page on another origin is already
    // refused -- and would break a header ReplayWeb.page decided to send.
    const res = await fetch(`http://127.0.0.1:${server.port}/example.wacz`, {
      method: "OPTIONS",
      headers: {
        Origin: REPLAY_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range,x-something-new",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("range,x-something-new");
    // And the origin stays narrow, which is the part that matters.
    expect(res.headers.get("access-control-allow-origin")).toBe(REPLAY_ORIGIN);
  });

  it("falls back to range when a preflight names nothing", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/example.wacz`, {
      method: "OPTIONS",
      headers: { Origin: REPLAY_ORIGIN, "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("range");
  });

  it("does not serve files outside the directory", async () => {
    // basename() strips the traversal rather than trusting the path.
    const res = await fetch(`http://127.0.0.1:${server.port}/../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it("answers 400 for a malformed escape instead of taking the process down", async () => {
    // decodeURIComponent throws synchronously in the request handler, and an
    // uncaught throw there ends the whole session — replay servers, widgets
    // and all.
    const res = await fetch(`http://127.0.0.1:${server.port}/%`);
    expect(res.status).toBe(400);

    // Still serving, which is the point.
    expect((await get("example.wacz")).status).toBe(200);
  });

  it("builds a replayweb.page url", () => {
    expect(server.url("example.wacz")).toBe(
      `https://replayweb.page/?source=http://localhost:${server.port}/example.wacz`,
    );
  });

  it("walks to the next port when one is taken", async () => {
    const second = await serveDir(dir, server.port);
    expect(second.port).toBe(server.port + 1);
    await second.close();
  });
});

describe("shutdown", () => {
  it("closes promptly even with a keep-alive connection open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-serve-close-"));
    fs.writeFileSync(path.join(dir, "a.wacz"), Buffer.alloc(64));
    const s = await serveDir(dir, 18200);

    // undici keeps the socket alive after the response is read.
    const res = await fetch(`http://127.0.0.1:${s.port}/a.wacz`);
    await res.arrayBuffer();

    const started = Date.now();
    await s.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
