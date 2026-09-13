/**
 * Talking to the browser inside the crawler container.
 *
 * The container runs a real Chrome with a DevTools endpoint, but Chrome binds
 * it to loopback *inside* the container, so publishing the port gets a
 * connection reset. The way in is to run the client in there too: the image
 * ships Node, and Node has a global WebSocket, so a CDP client needs no
 * dependency on either side.
 *
 * Each call is a short-lived process that connects, does one thing and exits.
 * A persistent session would save a few hundred milliseconds and cost a lot of
 * state; for a person trying selectors against a page, this is fast enough.
 */

import { spawn } from "node:child_process";
import { engine } from "./engine.ts";

/** Chrome's DevTools port inside the crawler image. */
export const CDP_PORT = 9221;

export interface CdpResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** console output produced while the expression ran. */
  console: string[];
  url?: string;
  title?: string;
}

/**
 * The client, as source to run inside the container. It takes its instructions
 * from argv so the expression never has to be spliced into the program text.
 */
const CLIENT = `
const [, , port, action, payload] = process.argv;
const out = (o) => { process.stdout.write(JSON.stringify(o)); };
try {
  const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) { out({ ok: false, error: "no page target in the browser", console: [] }); process.exit(0); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.delete(i)) rej(new Error(method + " timed out")); }, 20000);
    });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Runtime.consoleAPICalled") {
      logs.push(
        m.params.args
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.preview?.description ?? a.type)))
          .join(" "),
      );
    }
  });
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", () => j(new Error("cdp socket failed"))); });
  await send("Runtime.enable");
  // Runtime.enable replays the page's buffered console history, which would
  // attach three lines of unrelated startup noise to every result. Only what
  // happens from here on is ours.
  await new Promise((r) => setTimeout(r, 150));
  logs.length = 0;

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    const ex = r.result?.exceptionDetails;
    if (ex) return { ok: false, error: ex.exception?.description ?? ex.text ?? "evaluation failed" };
    return { ok: true, value: r.result?.result?.value };
  };

  if (action === "navigate") {
    await send("Page.enable");
    await send("Page.navigate", { url: payload });
    // Give the load a moment; a behaviour author cares about the settled page.
    await new Promise((r) => setTimeout(r, 2500));
  } else if (action === "eval") {
    const r = await evaluate(payload);
    const where = await evaluate("[location.href, document.title]");
    out({ ...r, console: logs, url: where.value?.[0], title: where.value?.[1] });
    ws.close();
    process.exit(0);
  }

  const where = await evaluate("[location.href, document.title]");
  out({ ok: true, console: logs, url: where.value?.[0], title: where.value?.[1] });
  ws.close();
  process.exit(0);
} catch (err) {
  out({ ok: false, error: String(err && err.message ? err.message : err), console: [] });
  process.exit(0);
}
`;

/**
 * Pipe the client into `node -` inside the container. The program arrives on
 * stdin and the expression as an argument, so nothing has to be escaped into
 * source text.
 */
async function run(container: string, action: string, payload: string): Promise<CdpResult> {
  const bin = await engine();
  if (!bin) return { ok: false, error: "no container engine available", console: [] };

  return new Promise<CdpResult>((resolve) => {
    const child = spawn(
      bin,
      ["exec", "-i", container, "node", "--input-type=module", "-", String(CDP_PORT), action, payload],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: "the browser did not answer within 45s", console: [] });
    }, 45_000);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, console: [] });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim() || "{}") as CdpResult);
      } catch {
        resolve({
          ok: false,
          error: (stderr.trim() || stdout.trim() || "the browser client produced no output").slice(0, 400),
          console: [],
        });
      }
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(CLIENT);
  });
}

/** Evaluate an expression in the open page. */
export function evaluate(container: string, expression: string): Promise<CdpResult> {
  return run(container, "eval", expression);
}

/** Point the browser at a url and wait for it to settle. */
export function navigate(container: string, url: string): Promise<CdpResult> {
  return run(container, "navigate", url);
}

/** What the browser currently has open. */
export function pageInfo(container: string): Promise<CdpResult> {
  return run(container, "info", "");
}
