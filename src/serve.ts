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
  return "application/octet-stream";
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

    // Strip any query and refuse traversal: only files directly in dir.
    // A malformed escape makes decodeURIComponent throw, and throwing here is
    // an uncaught exception that takes the whole session down with it.
    let name: string;
    try {
      name = path.basename(decodeURIComponent((req.url ?? "/").split("?")[0]!));
    } catch {
      res.writeHead(400, CORS);
      res.end("bad request");
      return;
    }
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
    // 127.0.0.1, not localhost. The listener above is IPv4-only, and on macOS
    // `localhost` resolves to ::1 first -- so a browser that does not fall
    // back to IPv4 reports a bare "NetworkError" and the archive looks broken
    // when it is serving fine. Naming the address that was actually bound
    // removes the guess.
    url: (file: string) => `${REPLAY_ORIGIN}/?source=http://127.0.0.1:${port}/${encodeURIComponent(file)}`,
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
    "\nChrome 141+ asks for Local Network Access permission on first load; click Allow, " +
      "or drag the .wacz onto https://replayweb.page instead.\n",
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
