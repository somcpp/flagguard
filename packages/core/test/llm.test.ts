import { createGateway } from "keyhopper";
import { describe, expect, it } from "vitest";
import { GeminiClient, LlmError, OpenAiCompatibleClient } from "../src/llm/client.js";
import { createLlmClient } from "../src/llm/factory.js";
import { hasKeyhopperKeys, KeyhopperClient } from "../src/llm/keyhopper.js";

const chatResponse = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 120 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("createLlmClient", () => {
  it("uses keyhopper automatically when multi-key env vars are set", () => {
    const client = createLlmClient(
      { LLM_PROVIDER: "auto" },
      { env: { GROQ_API_KEYS: "gsk_a,gsk_b", GEMINI_API_KEYS: "AIza_c" } },
    );
    expect(client).toBeInstanceOf(KeyhopperClient);
    expect((client as KeyhopperClient).describe().map((p) => [p.provider, p.keys])).toEqual([
      ["groq", 2],
      ["gemini", 1],
    ]);
  });

  it("falls back to the single-key clients", () => {
    expect(createLlmClient({ LLM_PROVIDER: "auto", LLM_API_KEY: "k" }, { env: {} })).toBeInstanceOf(
      GeminiClient,
    );
    expect(
      createLlmClient(
        { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "k", LLM_MODEL: "m" },
        { env: {} },
      ),
    ).toBeInstanceOf(OpenAiCompatibleClient);
  });

  it("prefers keyhopper keys over a pinned provider that has no key", () => {
    expect(
      createLlmClient({ LLM_PROVIDER: "gemini" }, { env: { GROQ_API_KEYS: "gsk_a" } }),
    ).toBeInstanceOf(KeyhopperClient);
    expect(
      createLlmClient(
        { LLM_PROVIDER: "gemini", LLM_API_KEY: "k" },
        { env: { GROQ_API_KEYS: "gsk_a" } },
      ),
    ).toBeInstanceOf(GeminiClient);
  });

  it("returns null (rules only) when nothing is configured", () => {
    expect(createLlmClient({ LLM_PROVIDER: "auto" }, { env: {} })).toBeNull();
  });

  it("explains a keyhopper provider without keys", () => {
    expect(() => createLlmClient({ LLM_PROVIDER: "keyhopper" }, { env: {} })).toThrow(
      /GROQ_API_KEYS/,
    );
  });

  it("detects keyhopper keys, ignoring blanks", () => {
    expect(hasKeyhopperKeys({ GROQ_API_KEYS: "  " })).toBe(false);
    expect(hasKeyhopperKeys({ OPENROUTER_API_KEYS: "sk-or-1" })).toBe(true);
  });
});

describe("KeyhopperClient", () => {
  function client(fetch: typeof globalThis.fetch) {
    return new KeyhopperClient({
      gateway: createGateway({
        providers: [
          { name: "groq", keys: ["gsk_aaaa1111"], models: ["openai/gpt-oss-120b"] },
          { name: "gemini", keys: ["AIza_bbbb2222"], models: ["gemini-2.5-flash"] },
        ],
        loadEnv: false,
        warnings: false,
        logs: false,
        maxWaitMs: 0,
        fetch,
      }),
    });
  }

  it("hops from a rate-limited Groq key to Gemini and reports it", async () => {
    const calls: string[] = [];
    const llm = client((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("groq")) {
        return Promise.resolve(
          new Response('{"error":{"message":"rate limited"}}', {
            status: 429,
            headers: { "retry-after": "7" },
          }),
        );
      }
      return Promise.resolve(chatResponse('{"ok":true}'));
    });

    const response = await llm.complete({ system: "s", prompt: "p", json: true });

    expect(response.text).toBe('{"ok":true}');
    expect(response.model).toBe("gemini/gemini-2.5-flash");
    expect(response.failovers).toBe(1);
    expect(response.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    expect(llm.model).toBe("gemini/gemini-2.5-flash");
    expect(calls[0]).toContain("groq");
  });

  it("sends JSON mode and the system prompt", async () => {
    let body: Record<string, unknown> = {};
    const llm = client((_input, init) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(chatResponse("{}"));
    });
    await llm.complete({ system: "be strict", prompt: "review", json: true });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "be strict" },
      { role: "user", content: "review" },
    ]);
  });

  it("raises LlmError listing every attempt when all providers fail", async () => {
    const llm = client(() => Promise.resolve(new Response("overloaded", { status: 503 })));
    const error = await llm.complete({ system: "s", prompt: "p" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as Error).message).toMatch(/All LLM providers failed .*groq.*gemini/);
  });
});
