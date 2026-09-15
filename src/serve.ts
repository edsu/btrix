/**
 * A local HTTP server for replaying a WACZ in ReplayWeb.page.
 *
 * ReplayWeb.page reads a remote .wacz by fetching the ZIP central directory
 * with range requests — including a suffix range (`Range: bytes=-N`) to find
 * the end-of-central-directory record — then pulls individual entries. So it
 * never downloads the whole archive, but it does need working ranges and CORS.
 *
 * In-process rather than spawning a helper: this is about sixty lines, it needs
 * no python3, and the lifecycle is a `close()` rather than tracking a child
 * process. Runnable directly too, for serving a WACZ from outside the store —
 * see the CLI at the bottom.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ReplayServer {
  port: number;
  /** Directory being served. */
  dir: string;
  url(file: string): string;
  close(): Promise<void>;
}

/**
 * ReplayWeb.page fetches the archive from here over CORS, so some origin has
 * to be allowed -- but not every origin. Binding to 127.0.0.1 is not a
 * boundary against the user's own browser: with `*`, any open tab could fetch
 * a .wacz, and the handler serves any file in the directory by basename, so
 * the .btrix.json sidecar (which carries the full config text) goes with it.
 * An archive of a logged-in crawl is exactly the thing not to hand over.
 */
export const REPLAY_ORIGIN = "https://replayweb.page";

const CORS = {
  "Access-Control-Allow-Origin": REPLAY_ORIGIN,
  // The origin is the boundary. Which request headers are allowed is not:
  // a page on another origin is already refused, so restricting these buys
  // nothing and risks breaking a header ReplayWeb.page decides to send.
  // Echoed from the preflight instead -- see the OPTIONS branch.
  "Vary": "Origin",
  "Accept-Ranges": "bytes",
  // Without this, script can only read the safelisted response headers, so
  // Content-Range and Accept-Ranges would be invisible to the reader that
  // asked for the range in the first place.
  "Access-Control-Expose-Headers": "content-range, accept-ranges, content-length, content-type",
};

/** `bytes=0-99`, `bytes=100-`, and the suffix form `bytes=-100`. */
export function parseRange(header: string, size: number): { start: number; end: number } | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, rawStart = "", rawEnd = ""] = m;

  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") {
    const len = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(len) || len <= 0) return undefined;
    return { start: Math.max(0, size - len), end: size - 1 };
  }
  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start >= size) return undefined;
  const end = rawEnd === "" ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (end < start) return undefined;
  return { start, end };
}

function contentType(file: string): string {
  if (file.endsWith(".wacz")) return "application/wacz+zip";
  if (file.endsWith(".json")) return "application/json";
  // The service worker is refused outright unless it arrives as JavaScript,
  // which is how a self-hosted replay page fails with nothing useful said.
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

/**
 * The vendored ReplayWeb.page bundle, served from btrix's own package so the
 * browser never leaves the loopback origin.
 *
 * Replaying through https://replayweb.page means a public page fetching
 * 127.0.0.1, which browsers and LAN-blocking extensions refuse -- observed
 * failing in Chrome and in Zen while a clean Firefox worked, on the same
 * archive and server. Served from here it is all one origin: no CORS, no
 * permission, no extension heuristic, and it works with no network at all.
 *
 * A fixed route list rather than a second directory to walk. The archive
 * handler deliberately resolves by basename so it cannot be walked out of,
 * and adding a servable tree would undo that.
 */
const DEFAULT_BUNDLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "replaywebpage");

/**
 * Overridable so the no-bundle path can be tested. It was not, and the cost
 * showed up immediately: the fallback branch held a line claiming nothing
 * left the machine directly beneath a replayweb.page link, and no test could
 * reach it to notice.
 */
let bundleDir = process.env.BTRIX_REPLAY_BUNDLE_DIR?.trim() || DEFAULT_BUNDLE_DIR;

/** For tests. Returns the previous value so a caller can put it back. */
export function setBundleDir(dir: string): string {
  const was = bundleDir;
  bundleDir = dir;
  cached.clear();
  return was;
}

function bundleRoutes(): Record<string, string> {
  return {
    "/ui.js": path.join(bundleDir, "ui.js"),
    // Must be under replay/: the element requests ./replay/sw.js, the default
    // replayBase, and the worker's scope has to cover where pages are served.
    "/replay/sw.js": path.join(bundleDir, "replay", "sw.js"),
  };
}

/**
 * How to get the bundle back, as an absolute path.
 *
 * "Run scripts/vendor-replay.sh" is no use to someone who installed globally:
 * from their own directory there is no such file. Re-vendoring into a global
 * node_modules also gets overwritten on the next upgrade, so reinstalling is
 * the better answer there -- the message offers both and lets the path make
 * clear which situation they are in.
 */
export function vendorHint(): string {
  const script = path.join(bundleDir, "..", "..", "scripts", "vendor-replay.sh");
  return bundleDir.includes(`${path.sep}node_modules${path.sep}`)
    ? `reinstall btrix (npm i -g @edsu/btrix), or run ${script}`
    : `run ${script}`;
}

/** Whether the vendored bundle is present, so callers can fall back. */
export function bundleAvailable(): boolean {
  return Object.values(bundleRoutes()).every((f) => fs.existsSync(f));
}

/**
 * Read once rather than per request. These are ~2MB of immutable vendored
 * files, and a synchronous re-read on every page load blocks the same
 * single-threaded server the browser is range-requesting the archive from.
 */
const cached = new Map<string, Buffer>();

function bundleFile(file: string): Buffer {
  const hit = cached.get(file);
  if (hit) return hit;
  const body = fs.readFileSync(file);
  cached.set(file, body);
  return body;
}

/**
 * The page that embeds the viewer. Generated rather than shipped as a file so
 * the archive name is injected here, where it can be checked against the
 * directory first. That is not the escaping, though, and treating it as such
 * was a mistake: matching the directory decides *which* name is used, not what
 * the name contains. A `.wacz` called `x" onfocus="...` is in the directory and
 * still closes the attribute.
 *
 * Hostile filenames are reachable. `collection:` is read out of a config with
 * a loose regex and never goes through isSafeStoreName, finishRun turns it into
 * the wacz filename, and the inventory hands it back as an archive -- so a
 * config written from a crawled page's own text can end up naming the file that
 * gets interpolated here. Escape it.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function replayPage(source: string): string {
  // Escaped once, used twice: the attribute and the title are both HTML text
  // contexts and both were injectable.
  const safe = escapeHtml(source);
  return `<!doctype html>
<html class="no-overflow">
  <head>
    <meta charset="utf-8">
    <title>${safe} — btrix</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="./ui.js"></script>
    <style>html,body{margin:0;height:100%}replay-web-page{display:block;height:100vh}</style>
  </head>
  <body>
    <!-- swName is also the element's own default; kept explicit because the
         bundle has null and page-param branches for it, and a silent change
         upstream would surface as "Service worker not found". The constraint
         that actually matters is on the server: the worker is served at
         /replay/sw.js, because the element resolves swName against its
         replaybase of "./replay/". -->
    <replay-web-page source="${safe}" swName="sw.js"></replay-web-page>
  </body>
</html>
`;
}

export async function serveDir(dir: string, preferredPort = 8087, attempts = 10): Promise<ReplayServer> {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      // Allow whatever was asked for. `Range` is CORS-safelisted, so a plain
      // range GET never preflights at all; this is for anything else the
      // reader sends, which is not something to guess at from here.
      const asked = req.headers["access-control-request-headers"];
      res.writeHead(204, {
        ...CORS,
        "Access-Control-Allow-Headers": typeof asked === "string" && asked ? asked : "range",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    // A malformed escape makes decodeURIComponent throw, and throwing here is
    // an uncaught exception that takes the whole session down with it.
    let route: string;
    let query: URLSearchParams;
    try {
      const [rawPath = "/", rawQuery = ""] = (req.url ?? "/").split("?");
      route = decodeURIComponent(rawPath);
      query = new URLSearchParams(rawQuery);
    } catch {
      res.writeHead(400, CORS);
      res.end("bad request");
      return;
    }

    // The replay page. `source` names an archive in this directory and nothing
    // else: it ends up in the DOM, so it is matched against the directory
    // rather than escaped and hoped for.
    if (route === "/" || route === "/index.html") {
      const wanted = query.get("source");
      const available = listArchiveFiles(dir);

      if (!available.length) {
        res.writeHead(404, { ...CORS, "Content-Type": contentType(".html") });
        res.end("<!doctype html><p>No .wacz in this directory.");
        return;
      }

      // A `source` that names nothing is an error, not an invitation to pick
      // something else. Substituting the first archive replayed a different
      // capture under the requested name's absence -- a deleted or renamed
      // file, or a stale bookmark, loaded successfully showing the wrong
      // thing, and someone would draw conclusions from it. Only a request
      // with no `source` at all gets a default.
      let source: string;
      if (wanted === null || wanted === "") {
        source = available[0]!;
      } else if (available.includes(path.basename(wanted))) {
        source = path.basename(wanted);
      } else {
        res.writeHead(404, { ...CORS, "Content-Type": contentType(".html") });
        res.end(
          `<!doctype html><meta charset="utf-8"><p>No <code>${escapeHtml(path.basename(wanted))}</code> here.` +
            `<p>This directory has:<ul>${available
              .map((f) => `<li><a href="/?source=${encodeURIComponent(f)}">${escapeHtml(f)}</a>`)
              .join("")}</ul>`,
        );
        return;
      }
      const body = Buffer.from(replayPage(source), "utf8");
      res.writeHead(200, { ...CORS, "Content-Type": contentType(".html"), "Content-Length": body.length });
      if (req.method === "HEAD") return res.end();
      res.end(body);
      return;
    }

    // The vendored viewer, from a fixed list rather than a walkable tree.
    const bundled = bundleRoutes()[route];
    if (bundled) {
      let body: Buffer;
      try {
        body = bundleFile(bundled);
      } catch {
        res.writeHead(404, CORS);
        res.end(`replay bundle missing — ${vendorHint()}`);
        return;
      }
      // Vendored and immutable, so a strong validator is honest and saves
      // re-sending two megabytes on every reload.
      const etag = `"${body.length.toString(16)}-${bundled.length.toString(16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ...CORS, ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        ...CORS,
        "Content-Type": contentType(bundled),
        "Content-Length": body.length,
        ETag: etag,
        "Cache-Control": "no-cache",
        // The worker's scope has to cover /replay/, which is where it serves
        // archived pages from.
        // Required: ui.js registers with scope "./" from a page at /, so the
        // worker claims the whole origin, and without this header the browser
        // refuses a worker served from /replay/ that asks for /.
        //
        // The consequence worth knowing: wabac's fetch handler is then
        // interposed on everything on this origin, including the browser's own
        // range requests for the .wacz. And ReplayServers reuses one port per
        // directory, so an activated worker outlives a btrix session and is
        // shared by every archive served from that port. Replaying one archive
        // and then another on the same port is covered by a test for exactly
        // that reason.
        ...(route === "/replay/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      });
      if (req.method === "HEAD") return res.end();
      res.end(body);
      return;
    }

    // Archives, resolved by basename so the directory cannot be walked out of.
    const name = path.basename(route);
    const file = path.join(dir, name);
    let size: number;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      res.writeHead(404, CORS);
      res.end("not found");
      return;
    }

    const headers = { ...CORS, "Content-Type": contentType(name) };
    const rangeHeader = req.headers.range;
    const range = rangeHeader ? parseRange(rangeHeader, size) : undefined;

    if (rangeHeader && !range) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }

    if (range) {
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": range.end - range.start + 1,
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    let tries = 0;

    const onError = (err: NodeJS.ErrnoException) => {
      // Someone else has the port — including a replay server left over from an
      // earlier session — so walk up rather than failing.
      if (err.code === "EADDRINUSE" && ++tries < attempts) {
        // A failed listen() leaves its one-time `listening` callback
        // registered. If it survives, it fires on the *next* successful bind
        // and reports the port we could not have, which would hand the user a
        // URL pointing at whatever else is on it.
        server.removeAllListeners("listening");
        server.once("listening", onListening);
        server.listen(preferredPort + tries, "127.0.0.1");
        return;
      }
      reject(err);
    };

    // The bound socket is the only trustworthy source for the port.
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("replay server bound to an unexpected address"));
    };

    server.on("error", onError);
    server.once("listening", onListening);
    server.listen(preferredPort, "127.0.0.1");
  });

  return {
    port,
    dir,
    // Same origin as the archive, which is the whole point: a page on
    // replayweb.page fetching 127.0.0.1 is what browsers and LAN-blocking
    // extensions refuse. Falls back to the hosted viewer if the bundle was
    // not vendored in, so a checkout without it still replays.
    //
    // 127.0.0.1, not localhost. The listener above is IPv4-only, and on macOS
    // `localhost` resolves to ::1 first -- so a browser that does not fall
    // back to IPv4 reports a bare "NetworkError" and the archive looks broken
    // when it is serving fine.
    url: (file: string) =>
      bundleAvailable()
        ? `http://127.0.0.1:${port}/?source=${encodeURIComponent(file)}`
        : `${REPLAY_ORIGIN}/?source=http://127.0.0.1:${port}/${encodeURIComponent(file)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() only stops accepting and then waits for open connections to
        // end. A browser replaying an archive holds keep-alive sockets, so
        // without this a session shutdown would block on them.
        server.closeAllConnections();
      }),
  };
}

/**
 * One server per directory, reused across calls and closed together at
 * shutdown. Archives normally all live in the store's out/, so in practice this
 * holds a single server; an adopted crawl replayed from elsewhere gets its own.
 */
export class ReplayServers {
  private readonly servers = new Map<string, ReplayServer>();

  async get(dir: string): Promise<ReplayServer> {
    const existing = this.servers.get(dir);
    if (existing) return existing;
    const server = await serveDir(dir, 8087 + this.servers.size);
    this.servers.set(dir, server);
    return server;
  }

  running(): ReplayServer[] {
    return [...this.servers.values()];
  }

  async closeAll(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => s.close()));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Runnable directly for serving an arbitrary directory by hand — the behaviors
 * skill's replay-debugging path, which is not always a store archive:
 *
 *   node <btrix>/src/serve.ts <directory> [port]
 *
 * Guarded so importing this module never starts a server.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const port = Number.parseInt(process.argv[3] ?? "8087", 10);
  if (!dir) {
    process.stderr.write("usage: serve.ts <directory> [port]\n");
    process.exit(2);
  }
  const server = await serveDir(path.resolve(dir), Number.isFinite(port) ? port : 8087);
  const archives = fs.readdirSync(server.dir).filter((f) => f.endsWith(".wacz"));
  process.stdout.write(`Serving ${server.dir} on port ${server.port} (ranges + CORS). Ctrl-C to stop.\n`);
  for (const a of archives) process.stdout.write(`\n  ${server.url(a)}\n`);
  if (!archives.length) process.stdout.write("\n(no .wacz files in that directory)\n");
  process.stdout.write(
    bundleAvailable()
      ? "\nThe viewer is served from this origin too, so nothing is fetched from the network.\n"
      : "\nNo viewer bundle here, so the links above go to replayweb.page — which means a public " +
          `page fetching 127.0.0.1, and some browsers and extensions refuse that. To serve the ` +
          `viewer locally, ${vendorHint()}. Or drag the .wacz onto https://replayweb.page, which ` +
          "reads from disk and always works.\n",
  );
}

/** The .wacz files a served directory offers. */
export function listArchiveFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".wacz")).sort();
  } catch {
    return [];
  }
}
