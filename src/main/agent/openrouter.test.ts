import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../../shared/types";
import type { ProviderSettings } from "../../shared/types";
import type { AdapterEvent } from "./adapter";
import { createAdapter, openRouterError, OpenRouterAdapter, openRouterHeaders, resetClientCache } from "./adapters";

/** A local stand-in for OpenRouter's Chat Completions endpoint that records each request. */
let server: http.Server;
let baseUrl = "";
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
let status = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "nope" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] });
      chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const settings = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  ...DEFAULT_PROVIDER_SETTINGS,
  provider: "openrouter",
  model: "openrouter/auto",
  apiKey: "sk-or-test",
  baseUrl,
  ...over,
});

async function run(adapter: OpenRouterAdapter): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn({ systemPrompt: "sys", turns: [{ kind: "text", role: "user", text: "hello" }], tools: [], onEvent: (e) => events.push(e), signal: new AbortController().signal });
  return events;
}

describe("OpenRouter provider", () => {
  it("sends the model as given with attribution headers and the user's key, with no price cap", async () => {
    resetClientCache();
    seen.length = 0;
    status = 200;
    const events = await run(new OpenRouterAdapter(settings({ model: "anthropic/claude-sonnet-5" }), { OPENROUTER_HTTP_REFERER: "https://archymedes.dev", OPENROUTER_APP_TITLE: "My App" }));

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe("Bearer sk-or-test");
    expect(seen[0].headers["http-referer"]).toBe("https://archymedes.dev");
    expect(seen[0].headers["x-title"]).toBe("My App");
    expect(seen[0].body.model).toBe("anthropic/claude-sonnet-5");
    expect(seen[0].body).not.toHaveProperty("provider");
    expect(events).toContainEqual({ type: "text-delta", delta: "hi" });
  });

  it("defaults X-Title to the app and omits HTTP-Referer when unset", () => {
    expect(openRouterHeaders({})).toEqual({ "X-Title": "Archymedes Desktop" });
  });

  it("turns HTTP failures into OpenRouter's hints, keeping the status", async () => {
    resetClientCache();
    status = 401;
    const error = await run(new OpenRouterAdapter(settings(), {})).catch((e: unknown) => e);
    status = 200;
    expect(error).toMatchObject({ status: 401, message: "OpenRouter rejected the key. Update the API key in Settings." });
    expect(openRouterError(Object.assign(new Error("x"), { status: 402 })).message).toMatch(/quota/);
    expect(openRouterError(new Error("plain")).message).toBe("plain");
  });

  it("requires a key and is what createAdapter builds for openrouter", () => {
    expect(() => new OpenRouterAdapter(settings({ apiKey: "" }))).toThrow(/API key/);
    expect(createAdapter(settings()).name).toBe("openrouter");
  });
});
