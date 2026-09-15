/**
 * The replay server. ReplayWeb.page reads a .wacz by range-requesting the ZIP
 * central directory — including a *suffix* range to find the
 * end-of-central-directory record — so ranges are not optional garnish here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPLAY_ORIGIN, bundleAvailable, parseRange, replayPage, serveDir, setBundleDir, type ReplayServer } from "../src/serve.ts";

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
    // Port 0: the OS picks a free one, and serveDir reports what it actually
    // bound. Every test in this file binding the same fixed port meant a run
    // of rapid bind/close cycles, which intermittently reset a connection.
    server = await serveDir(dir, 0);
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

  it("names 127.0.0.1 rather than localhost, which may resolve to ::1 first", () => {
    // The server binds IPv4 loopback only. On a machine where localhost
    // resolves to ::1 ahead of 127.0.0.1 -- the macOS default -- a browser
    // that does not fall back reports a bare network error, and the archive
    // looks broken when it is fine.
    expect(server.url("example.wacz")).toContain("http://127.0.0.1:");
    expect(server.url("example.wacz")).not.toContain("localhost");
  });

  it("builds a same-origin url when the viewer is vendored in", () => {
    // The point of vendoring: a page on replayweb.page fetching 127.0.0.1 is
    // what browsers and LAN-blocking extensions refuse. Same origin, no hop.
    expect(bundleAvailable()).toBe(true);
    expect(server.url("example.wacz")).toBe(`http://127.0.0.1:${server.port}/?source=example.wacz`);
    expect(server.url("example.wacz")).not.toContain("replayweb.page");
  });

  it("walks to the next port when one is taken", async () => {
    const second = await serveDir(dir, server.port);
    expect(second.port).toBe(server.port + 1);
    await second.close();
  });

  describe("the self-hosted viewer", () => {
    // Replaying through replayweb.page means a public page fetching 127.0.0.1,
    // which browsers and LAN-blocking extensions refuse. Served from here it is
    // one origin, and it works with no network at all.
    it("serves a page that embeds the archive", async () => {
      const res = await get("");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("<replay-web-page");
      expect(html).toContain('source="example.wacz"');
    });

    it("serves the worker as javascript, or the browser refuses it outright", async () => {
      const res = await get("replay/sw.js");
      expect(res.status).toBe(200);
      // application/octet-stream here is a silent, total failure.
      expect(res.headers.get("content-type")).toBe("text/javascript");
      expect(res.headers.get("service-worker-allowed")).toBe("/");
    });

    it("serves the app bundle as javascript", async () => {
      const res = await get("ui.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/javascript");
      expect(Number(res.headers.get("content-length"))).toBeGreaterThan(100_000);
    });

    it("escapes the archive name, which is not the same as matching it", async () => {
      // Matching the directory decides which name is used, not what it
      // contains -- and a hostile name is reachable, because `collection:` is
      // read from a config with a loose regex, becomes the wacz filename, and
      // comes back as an archive. So the name that reaches the DOM is escaped.
      const nasty = 'x" onfocus="alert(1).wacz';
      fs.writeFileSync(path.join(dir, nasty), body);
      fs.rmSync(path.join(dir, "example.wacz"));

      const html = await (await get("")).text();

      expect(html).not.toContain('onfocus="alert(1)');
      expect(html).toContain("&quot;");
      // The real name still arrives, just inert.
      expect(html).toContain("x&quot; onfocus=&quot;alert(1).wacz");
    });

    it("escapes the title as well as the attribute", async () => {
      // No slash: it has to be a name the filesystem will actually accept.
      const nasty = "a<script>alert(1).wacz";
      fs.writeFileSync(path.join(dir, nasty), body);
      fs.rmSync(path.join(dir, "example.wacz"));

      const html = await (await get("")).text();

      expect(html).not.toContain("<script>alert(1)");
      expect(html).toContain("&lt;script&gt;alert(1)");
    });

    it("leaves an ordinary name readable", async () => {
      const html = await (await get("")).text();
      expect(html).toContain('source="example.wacz"');
      expect(html).toContain("example.wacz — btrix");
    });

    it("only embeds an archive that is really in the directory", async () => {
      // `source` lands in the DOM, so it is matched against the directory
      // rather than escaped and hoped for.
      const res = await get("?source=" + encodeURIComponent('"><script>alert(1)</script>'));
      const html = await res.text();
      expect(html).not.toContain("<script>alert(1)");
      // Falls back to a real archive rather than embedding nothing.
      expect(html).toContain('source="example.wacz"');
    });

    it("refuses a traversal dressed up as a source", async () => {
      const res = await get("?source=" + encodeURIComponent("../../../../etc/passwd"));
      const html = await res.text();
      expect(html).not.toContain("etc/passwd");
      expect(html).toContain('source="example.wacz"');
    });

    it("still resolves archives by basename, so the directory is not walkable", async () => {
      const res = await get("../../../../etc/passwd");
      expect(res.status).toBe(404);
    });

    it("answers HEAD on the generated page without a body", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });

    it("reports the page when the directory holds no archive", async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-empty-"));
      const s2 = await serveDir(empty, 0);
      try {
        const res = await fetch(`http://127.0.0.1:${s2.port}/`);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain("No .wacz");
      } finally {
        await s2.close();
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("replayPage", () => {
    it("points the worker at sw.js, which the server puts under replay/", () => {
      // The element asks for ./replay/sw.js. Beside ui.js it is not found, and
      // the only symptom is "Service worker not found".
      expect(replayPage("a.wacz")).toContain('swName="sw.js"');
      expect(replayPage("a.wacz")).toContain('src="./ui.js"');
    });
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

describe("without the vendored viewer", () => {
  // This whole branch was unreachable from a test, and a bug lived in it: the
  // collapsed btrix_view line claimed nothing left the machine, printed under
  // a replayweb.page link. A seam is the difference between catching that and
  // shipping it.
  let dir: string;
  let server: ReplayServer;
  let restore: string;

  beforeEach(async () => {
    restore = setBundleDir(path.join(os.tmpdir(), "btrix-no-such-bundle"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-nobundle-"));
    fs.writeFileSync(path.join(dir, "example.wacz"), Buffer.alloc(100));
    server = await serveDir(dir, 0);
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    setBundleDir(restore);
  });

  it("reports the bundle as unavailable", () => {
    expect(bundleAvailable()).toBe(false);
  });

  it("falls back to a replayweb.page url, so a checkout without it still replays", () => {
    expect(server.url("example.wacz")).toBe(
      `https://replayweb.page/?source=http://127.0.0.1:${server.port}/example.wacz`,
    );
  });

  it("says how to fix it rather than 404ing blankly", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/ui.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("vendor-replay.sh");
  });

  it("still serves archives", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/example.wacz`);
    expect(res.status).toBe(200);
  });
});

describe("the bundle is read once and revalidated", () => {
  // ~2MB of immutable files; a synchronous re-read per request blocks the
  // same server the browser is range-requesting the archive from.
  let dir: string;
  let server: ReplayServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-etag-"));
    fs.writeFileSync(path.join(dir, "example.wacz"), Buffer.alloc(100));
    server = await serveDir(dir, 0);
  });
  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("offers an etag and honours it", async () => {
    const first = await fetch(`http://127.0.0.1:${server.port}/ui.js`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await fetch(`http://127.0.0.1:${server.port}/ui.js`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });
});
