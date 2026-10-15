/**
 * `/endpoint`: connect btrix to any OpenAI-compatible API without hand-editing
 * JSON.
 *
 * pi can already talk to such an endpoint, but only through a provider entry
 * in `models.json` that names every model, plus a key in `auth.json` -- two
 * files in an agent directory the user has never heard of. This asks for a
 * base URL and a key, checks both by listing the endpoint's models, and writes
 * the same entry the user would otherwise have written by hand. Plain files,
 * so the result stays easy to inspect and edit.
 *
 * The key goes in `auth.json`, beside `/login` credentials, rather than in
 * `models.json`: that file is 0600 and `/logout` knows how to remove it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The dialog surface this needs, so the flow can be tested without a harness. */
export interface EndpointUI {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** The slice of pi's runtime the flow touches. */
export interface EndpointHost {
  agentDir: string;
  /** Whether pi already has a provider by this id: built-in, extension or models.json. */
  hasProvider(id: string): boolean;
  /** Reload models.json and credentials for one provider. */
  refresh(id: string): Promise<void>;
  /** Switch the session to a model. False if pi could not find or use it. */
  useModel(provider: string, id: string): Promise<boolean>;
  fetch?: typeof fetch;
}

/**
 * Model modes, as LiteLLM-style gateways report them, that are not chat.
 * Offering a speech model in `/model` only produces a confusing error later.
 */
const NON_CHAT_MODES = new Set([
  "audio_transcription",
  "audio_speech",
  "embedding",
  "image_generation",
  "image_edit",
  "moderation",
  "rerank",
]);

/**
 * The base URL pi wants: the part before `/chat/completions`. People paste
 * whatever their provider's docs show, so accept the full route too.
 */
export function normalizeBaseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  url.search = "";
  url.hash = "";
  const trimmed = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|completions|models)$/, "");
  return `${url.origin}${trimmed}`;
}

/** A provider id suggested from the host: `gateway.inference.coop` → `inference-coop`. */
export function suggestProviderId(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const parts = host.split(".").filter((p) => p && p !== "www");
  // A leading api./gateway./llm. says nothing about whose endpoint it is.
  if (parts.length > 2 && /^(api|gateway|llm|inference|ai)$/.test(parts[0]!)) parts.shift();
  const id = parts.join("-").replace(/[^a-z0-9-]/g, "-");
  return id || "custom";
}

export function validProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

/** Chat model ids from an OpenAI-style `GET /models` body, sorted. */
export function chatModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .filter((m): m is { id: string; mode?: unknown } => typeof m?.id === "string" && m.id.trim() !== "")
    .filter((m) => typeof m.mode !== "string" || !NON_CHAT_MODES.has(m.mode))
    .map((m) => m.id);
  return [...new Set(ids)].sort();
}

export type ListResult =
  | { ok: true; ids: string[] }
  /** The endpoint answered and refused the key. */
  | { ok: false; kind: "auth"; message: string }
  /**
   * Something answered, but not an API: usually a portal or sign-in page on a
   * different host from the endpoint it issues keys for.
   */
  | { ok: false; kind: "not-api"; message: string }
  /** The endpoint answered but has no usable model list. */
  | { ok: false; kind: "no-list"; message: string }
  /** Nothing answered. */
  | { ok: false; kind: "unreachable"; message: string };

export async function listModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(15_000),
): Promise<ListResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal,
    });
  } catch (err) {
    return { ok: false, kind: "unreachable", message: (err as Error).message };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "auth", message: `${res.status} ${res.statusText}`.trim() };
  }
  if (!res.ok) return { ok: false, kind: "no-list", message: `${res.status} ${res.statusText}`.trim() };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "not-api", message: "the response was not JSON" };
  }
  const ids = chatModelIds(body);
  return ids.length ? { ok: true, ids } : { ok: false, kind: "no-list", message: "it listed no chat models" };
}

type Json = Record<string, unknown>;

/**
 * models.json with this provider added or replaced.
 *
 * Everything else in the file is kept, and so is anything the user added to
 * this provider by hand: headers, compat flags, and per-model metadata such as
 * a context window for a model that is still listed.
 */
export function mergeModelsJson(
  current: string | undefined,
  id: string,
  provider: { name: string; baseUrl: string; ids: string[]; apiKey?: string },
): string {
  const doc: Json = current?.trim() ? JSON.parse(current) : {};
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("models.json is not an object");
  const providers = (doc.providers ?? {}) as Json;
  if (typeof providers !== "object" || Array.isArray(providers)) throw new Error("`providers` is not an object");

  const before = (providers[id] ?? {}) as Json;
  const known = new Map<string, Json>();
  for (const m of Array.isArray(before.models) ? (before.models as Json[]) : []) {
    if (typeof m?.id === "string") known.set(m.id, m);
  }

  const entry: Json = {
    ...before,
    // A display name the user chose by hand outlives a re-run.
    name: typeof before.name === "string" ? before.name : provider.name,
    baseUrl: provider.baseUrl,
    api: "openai-completions",
    models: provider.ids.map((m) => known.get(m) ?? { id: m }),
  };
  // Only a placeholder, so never in place of a value the user set.
  if (provider.apiKey !== undefined && before.apiKey === undefined) entry.apiKey = provider.apiKey;

  return `${JSON.stringify({ ...doc, providers: { ...providers, [id]: entry } }, null, 2)}\n`;
}

/**
 * A key as pi should read it back. pi expands `$NAME` and runs a leading `!`
 * as a command in stored keys, so a pasted literal has to be escaped or a key
 * that happens to contain `$` is silently mangled.
 */
export function escapeConfigLiteral(key: string): string {
  const escaped = key.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/** Write via a temporary file, so a crash cannot leave half a config behind. */
function writeAtomic(file: string, text: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  try {
    // Keep an existing file's permissions rather than imposing ours.
    fs.chmodSync(tmp, fs.statSync(file).mode & 0o777);
  } catch {
    // New file: the mode given above stands.
  }
  fs.renameSync(tmp, file);
}

/**
 * Hold pi's lock on auth.json while changing it.
 *
 * pi guards the file with proper-lockfile, whose lock is a `<file>.lock`
 * directory that it treats as stale after 10 seconds. Taking the same lock by
 * hand avoids depending on a package btrix does not declare.
 */
async function withAuthLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (attempt >= 50) throw new Error(`${lock} is held by another process`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export async function storeApiKey(agentDir: string, id: string, key: string): Promise<void> {
  const file = path.join(agentDir, "auth.json");
  await withAuthLock(file, () => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const doc: Json = current.trim() ? JSON.parse(current) : {};
    doc[id] = { type: "api_key", key: escapeConfigLiteral(key) };
    writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  });
}

function readModelsJson(file: string): { text?: string; providers: Json } {
  if (!fs.existsSync(file)) return { providers: {} };
  const text = fs.readFileSync(file, "utf8");
  const doc = text.trim() ? JSON.parse(text) : {};
  return { text, providers: (doc?.providers ?? {}) as Json };
}

/** The whole conversation. Returns the provider id written, if any. */
export async function setupEndpoint(ui: EndpointUI, host: EndpointHost): Promise<string | undefined> {
  const modelsPath = path.join(host.agentDir, "models.json");

  // Refuse up front to touch a models.json that is already broken, rather than
  // after the user has typed a key.
  let existing: ReturnType<typeof readModelsJson>;
  try {
    existing = readModelsJson(modelsPath);
  } catch (err) {
    ui.notify(`${modelsPath} could not be read (${(err as Error).message}). Fix or move it, then try again.`, "error");
    return undefined;
  }

  const rawUrl = await ui.input("Base URL of the OpenAI-compatible API", "https://example.org/v1");
  if (!rawUrl?.trim()) return undefined;
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) {
    ui.notify(`"${rawUrl.trim()}" is not an http or https URL.`, "error");
    return undefined;
  }

  const rawKey = await ui.input("API key (leave empty if the endpoint needs none)");
  if (rawKey === undefined) return undefined;
  const key = rawKey.trim() || undefined;

  let ids: string[];
  const listed = await listModels(baseUrl, key, host.fetch);
  if (listed.ok) {
    ids = listed.ids;
  } else if (listed.kind === "auth") {
    ui.notify(`${baseUrl} refused the key (${listed.message}). Nothing was saved.`, "error");
    return undefined;
  } else if (listed.kind === "not-api") {
    ui.notify(
      `${baseUrl}/models answered with a web page, not an API. A gateway's portal or dashboard is usually a ` +
        `different host from its API. Nothing was saved.`,
      "error",
    );
    return undefined;
  } else if (listed.kind === "unreachable") {
    ui.notify(`Could not reach ${baseUrl}: ${listed.message}. Nothing was saved.`, "error");
    return undefined;
  } else {
    // Some servers have no model list. That is not a reason to give up.
    const typed = await ui.input(
      `${baseUrl}/models gave no model list (${listed.message}). Model id to use`,
      "for example llama-3.3-70b",
    );
    if (!typed?.trim()) return undefined;
    ids = [typed.trim()];
  }

  const suggested = suggestProviderId(baseUrl);
  const rawId = await ui.input(`Name for this provider (default ${suggested})`, suggested);
  if (rawId === undefined) return undefined;
  const id = rawId.trim().toLowerCase() || suggested;
  if (!validProviderId(id)) {
    ui.notify(`"${id}" is not a usable name: use lowercase letters, digits, "-", "." or "_".`, "error");
    return undefined;
  }
  const ours = Object.hasOwn(existing.providers, id);
  if (!ours && host.hasProvider(id)) {
    // Writing it would change a provider pi ships with, which is not what
    // someone adding a new endpoint means to do.
    ui.notify(`"${id}" is one of pi's own providers. Pick another name.`, "error");
    return undefined;
  }
  if (ours && !(await ui.confirm(`Replace "${id}"?`, `${modelsPath} already has a provider called "${id}".`))) {
    return undefined;
  }

  try {
    const text = mergeModelsJson(existing.text, id, {
      name: id,
      baseUrl,
      ids,
      // pi lists a provider's models only once it has some credential. A
      // keyless local server still needs a placeholder, as pi's docs do for
      // Ollama.
      apiKey: key ? undefined : "none",
    });
    writeAtomic(modelsPath, text, 0o644);
    if (key) await storeApiKey(host.agentDir, id, key);
  } catch (err) {
    ui.notify(`Could not save the endpoint: ${(err as Error).message}`, "error");
    return undefined;
  }

  await host.refresh(id);

  const plural = ids.length === 1 ? "model" : "models";
  const chosen = ids.length === 1 ? ids[0] : await ui.select(`Use which ${id} model now?`, ids);
  if (chosen && !(await host.useModel(id, chosen))) {
    ui.notify(`Saved ${ids.length} ${plural} under "${id}", but pi could not switch to ${chosen}. Try /model.`, "warning");
    return id;
  }
  ui.notify(
    `Saved ${ids.length} ${plural} under "${id}" in ${modelsPath}${chosen ? `; now using ${id}/${chosen}` : ""}. ` +
      `/model switches between them.`,
    "info",
  );
  return id;
}
