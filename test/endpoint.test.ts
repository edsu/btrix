/**
 * `/endpoint`: adding an OpenAI-compatible provider without hand-editing JSON.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatModelIds,
  type EndpointHost,
  type EndpointUI,
  escapeConfigLiteral,
  listModels,
  mergeModelsJson,
  normalizeBaseUrl,
  setupEndpoint,
  storeApiKey,
  suggestProviderId,
} from "../src/endpoint.ts";

/** The shape LiteLLM's gateway actually returns, speech models included. */
const GATEWAY_LIST = {
  object: "list",
  data: [
    { id: "tinfoil/glm-5.3", object: "model" },
    { id: "greenpt/deepseek-v4.1-flash", object: "model" },
    { id: "tinfoil/whisper-large-v3-turbo", object: "model", mode: "audio_transcription" },
    { id: "tinfoil/voxtral-tts", object: "model", mode: "audio_speech" },
  ],
};

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("normalizeBaseUrl", () => {
  it("accepts the base URL and the routes people paste instead", () => {
    expect(normalizeBaseUrl("https://gateway.inference.coop/v1")).toBe("https://gateway.inference.coop/v1");
    expect(normalizeBaseUrl(" https://gateway.inference.coop/v1/ ")).toBe("https://gateway.inference.coop/v1");
    expect(normalizeBaseUrl("https://x.org/v1/chat/completions")).toBe("https://x.org/v1");
    expect(normalizeBaseUrl("https://x.org/v1/models?a=b")).toBe("https://x.org/v1");
    expect(normalizeBaseUrl("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
  });

  it("refuses what is not an http endpoint, and credentials in the URL", () => {
    expect(normalizeBaseUrl("gateway.inference.coop")).toBeUndefined();
    expect(normalizeBaseUrl("ftp://x.org/v1")).toBeUndefined();
    expect(normalizeBaseUrl("https://user:secret@x.org/v1")).toBeUndefined();
  });
});

describe("suggestProviderId", () => {
  it("names the provider after the host, minus a generic first label", () => {
    expect(suggestProviderId("https://gateway.inference.coop/v1")).toBe("inference-coop");
    expect(suggestProviderId("https://api.groq.com/openai/v1")).toBe("groq-com");
    expect(suggestProviderId("http://localhost:1234/v1")).toBe("localhost");
    expect(suggestProviderId("http://127.0.0.1:8000/v1")).toBe("127-0-0-1");
  });
});

describe("chatModelIds", () => {
  it("keeps chat models and drops speech, embedding and the like", () => {
    expect(chatModelIds(GATEWAY_LIST)).toEqual(["greenpt/deepseek-v4.1-flash", "tinfoil/glm-5.3"]);
  });

  it("survives a body that is not a model list", () => {
    expect(chatModelIds(null)).toEqual([]);
    expect(chatModelIds({ data: "nope" })).toEqual([]);
    expect(chatModelIds({ data: [{ id: 3 }, {}, { id: "" }, { id: "a" }, { id: "a" }] })).toEqual(["a"]);
  });
});

describe("listModels", () => {
  it("sends the key as a bearer token", async () => {
    const f = respond(200, GATEWAY_LIST);
    const r = await listModels("https://x.org/v1", "sk-1", f);
    expect(r).toEqual({ ok: true, ids: ["greenpt/deepseek-v4.1-flash", "tinfoil/glm-5.3"] });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://x.org/v1/models");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-1" });
  });

  it("tells a refused key apart from a missing list and from no answer", async () => {
    expect((await listModels("https://x.org/v1", "bad", respond(401, {}))) as any).toMatchObject({ kind: "auth" });
    expect((await listModels("https://x.org/v1", "k", respond(404, {}))) as any).toMatchObject({ kind: "no-list" });
    expect((await listModels("https://x.org/v1", "k", respond(200, { data: [] }))) as any).toMatchObject({
      kind: "no-list",
    });
    // A portal, or a redirect to a sign-in page: fetch follows it to HTML.
    const portal = vi.fn(async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch;
    expect((await listModels("https://x.org/v1", "k", portal)) as any).toMatchObject({ kind: "not-api" });
    const down = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect((await listModels("https://x.org/v1", "k", down)) as any).toMatchObject({ kind: "unreachable" });
  });
});

describe("mergeModelsJson", () => {
  it("adds a provider and leaves the rest of the file alone", () => {
    const before = JSON.stringify({ $schema: "s", providers: { ollama: { baseUrl: "http://l/v1" } } });
    const out = JSON.parse(mergeModelsJson(before, "coop", { name: "coop", baseUrl: "https://c/v1", ids: ["m"] }));
    expect(out.$schema).toBe("s");
    expect(out.providers.ollama).toEqual({ baseUrl: "http://l/v1" });
    expect(out.providers.coop).toEqual({
      name: "coop",
      baseUrl: "https://c/v1",
      api: "openai-completions",
      models: [{ id: "m" }],
    });
  });

  it("keeps hand-added settings and model metadata when re-run", () => {
    const before = JSON.stringify({
      providers: {
        coop: {
          name: "InferenceCoop",
          baseUrl: "https://old/v1",
          headers: { "X-Org": "1" },
          models: [
            { id: "kept", contextWindow: 1000000 },
            { id: "gone", contextWindow: 8 },
          ],
        },
      },
    });
    const out = JSON.parse(
      mergeModelsJson(before, "coop", { name: "coop", baseUrl: "https://new/v1", ids: ["kept", "new"] }),
    );
    expect(out.providers.coop).toEqual({
      name: "InferenceCoop",
      baseUrl: "https://new/v1",
      headers: { "X-Org": "1" },
      api: "openai-completions",
      models: [{ id: "kept", contextWindow: 1000000 }, { id: "new" }],
    });
  });

  it("does not put the placeholder key over one set by hand", () => {
    const before = JSON.stringify({ providers: { local: { apiKey: "$LOCAL_KEY" } } });
    const out = JSON.parse(mergeModelsJson(before, "local", { name: "local", baseUrl: "u", ids: ["m"], apiKey: "none" }));
    expect(out.providers.local.apiKey).toBe("$LOCAL_KEY");
  });

  it("starts from nothing, and refuses to overwrite a file it cannot parse", () => {
    expect(JSON.parse(mergeModelsJson(undefined, "a", { name: "a", baseUrl: "u", ids: ["m"] })).providers.a).toBeTruthy();
    expect(() => mergeModelsJson("{ not json", "a", { name: "a", baseUrl: "u", ids: ["m"] })).toThrow();
  });
});

describe("escapeConfigLiteral", () => {
  it("keeps pi from expanding or executing a pasted key", () => {
    expect(escapeConfigLiteral("sk-plain")).toBe("sk-plain");
    expect(escapeConfigLiteral("sk-$HOME")).toBe("sk-$$HOME");
    expect(escapeConfigLiteral("!rm")).toBe("$!rm");
  });
});

describe("setupEndpoint", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrix-endpoint-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A UI that answers `input` prompts in order. */
  const scripted = (inputs: (string | undefined)[], pick?: string, confirm = true) => {
    const notes: { message: string; type?: string }[] = [];
    const ui: EndpointUI = {
      input: vi.fn(async () => inputs.shift()),
      select: vi.fn(async () => pick),
      confirm: vi.fn(async () => confirm),
      notify: (message, type) => notes.push({ message, type }),
    };
    return { ui, notes };
  };

  const host = (over: Partial<EndpointHost> = {}): EndpointHost & { used: string[] } => {
    const used: string[] = [];
    return {
      agentDir: dir,
      hasProvider: (id) => id === "openai",
      refresh: vi.fn(async () => undefined),
      useModel: async (p, id) => {
        used.push(`${p}/${id}`);
        return true;
      },
      fetch: respond(200, GATEWAY_LIST),
      used,
      ...over,
    };
  };

  const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

  it("writes the provider and the key, then switches to the chosen model", async () => {
    const { ui, notes } = scripted(["https://gateway.inference.coop/v1", "sk-secret", ""], "tinfoil/glm-5.3");
    const h = host();
    expect(await setupEndpoint(ui, h)).toBe("inference-coop");

    const provider = readJson("models.json").providers["inference-coop"];
    expect(provider.baseUrl).toBe("https://gateway.inference.coop/v1");
    expect(provider.models.map((m: any) => m.id)).toEqual(["greenpt/deepseek-v4.1-flash", "tinfoil/glm-5.3"]);
    // The key is in auth.json, not in models.json in the clear.
    expect(provider.apiKey).toBeUndefined();
    expect(readJson("auth.json")["inference-coop"]).toEqual({ type: "api_key", key: "sk-secret" });
    expect(fs.statSync(path.join(dir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "auth.json.lock"))).toBe(false);

    expect(h.refresh).toHaveBeenCalledWith("inference-coop");
    expect(h.used).toEqual(["inference-coop/tinfoil/glm-5.3"]);
    expect(notes.at(-1)?.type).toBe("info");
  });

  it("adds to an auth.json that already holds other credentials", async () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "x" } }), {
      mode: 0o600,
    });
    await storeApiKey(dir, "coop", "k");
    expect(readJson("auth.json")).toEqual({ anthropic: { type: "oauth", access: "x" }, coop: { type: "api_key", key: "k" } });
  });

  it("saves nothing when the endpoint refuses the key", async () => {
    const { ui, notes } = scripted(["https://x.org/v1", "wrong"]);
    expect(await setupEndpoint(ui, host({ fetch: respond(401, {}) }))).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "models.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
    expect(notes[0]?.message).toContain("refused the key");
  });

  it("saves nothing when the URL is a web page rather than an API", async () => {
    const html = vi.fn(async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch;
    const { ui, notes } = scripted(["https://portal.x.org/", "k"]);
    expect(await setupEndpoint(ui, host({ fetch: html }))).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "models.json"))).toBe(false);
    expect(notes[0]?.message).toContain("not an API");
    // It did not fall through to asking for a model id.
    expect(ui.input).toHaveBeenCalledTimes(2);
  });

  it("asks for a model id when the endpoint has no list", async () => {
    const { ui } = scripted(["http://localhost:8000/v1", "", "my-model", "local"]);
    expect(await setupEndpoint(ui, host({ fetch: respond(404, {}) }))).toBe("local");
    const provider = readJson("models.json").providers.local;
    expect(provider.models).toEqual([{ id: "my-model" }]);
    // No key: a placeholder, or pi never offers the model.
    expect(provider.apiKey).toBe("none");
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("will not shadow one of pi's own providers", async () => {
    const { ui, notes } = scripted(["https://x.org/v1", "k", "openai"]);
    expect(await setupEndpoint(ui, host())).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "models.json"))).toBe(false);
    expect(notes[0]?.message).toContain("pi's own providers");
  });

  it("asks before replacing a provider it wrote earlier", async () => {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { coop: { baseUrl: "old" } } }));
    const { ui } = scripted(["https://x.org/v1", "k", "coop"], undefined, false);
    // pi knows the provider because models.json declares it.
    expect(await setupEndpoint(ui, host({ hasProvider: () => true }))).toBeUndefined();
    expect(readJson("models.json").providers.coop).toEqual({ baseUrl: "old" });
  });

  it("leaves a broken models.json alone, before asking anything", async () => {
    fs.writeFileSync(path.join(dir, "models.json"), "{ broken");
    const { ui, notes } = scripted([]);
    expect(await setupEndpoint(ui, host())).toBeUndefined();
    expect(ui.input).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "models.json"), "utf8")).toBe("{ broken");
    expect(notes[0]?.type).toBe("error");
  });

  it("stops quietly when a prompt is dismissed", async () => {
    const { ui, notes } = scripted([undefined]);
    expect(await setupEndpoint(ui, host())).toBeUndefined();
    expect(notes).toEqual([]);
  });
});
