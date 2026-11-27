import { describe, expect, it, vi } from "vitest";
import { FlagsmithApiError } from "../src/errors.js";
import { type FetchLike, HttpClient } from "../src/flagsmith/http.js";

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function client(fetch: FetchLike, sleep = vi.fn((_ms: number) => Promise.resolve())) {
  return {
    http: new HttpClient({ baseUrl: "https://flagsmith.test/", apiKey: "secret", fetch, sleep }),
    sleep,
  };
}

describe("HttpClient", () => {
  it("sends the Api-Key authorization header and JSON body", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(respond(201, { id: 1 })));
    const { http } = client(fetch);

    await expect(http.post("/api/v1/things/", { name: "x" })).resolves.toEqual({ id: 1 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://flagsmith.test/api/v1/things/");
    expect(new Headers(init?.headers).get("authorization")).toBe("Api-Key secret");
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("serialises query parameters and drops undefined ones", () => {
    const { http } = client(vi.fn<FetchLike>());
    expect(http.url("/x/", { a: 1, b: undefined, c: true })).toBe(
      "https://flagsmith.test/x/?a=1&c=true",
    );
  });

  it("retries server errors with exponential backoff, then succeeds", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(respond(502))
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(200, { ok: true }));
    const { http, sleep } = client(fetch);

    await expect(http.get("/x/")).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([300, 600]);
  });

  it("honours Retry-After on 429", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(respond(429, undefined, { "Retry-After": "2" }))
      .mockResolvedValueOnce(respond(200, {}));
    const { http, sleep } = client(fetch);

    await http.post("/x/", {});
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not retry non-idempotent POSTs on server errors", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(respond(500)));
    const { http } = client(fetch);

    await expect(http.post("/x/", {})).rejects.toBeInstanceOf(FlagsmithApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails fast on client errors with a descriptive error", async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(respond(400, { name: ["already exists"] })),
    );
    const { http } = client(fetch);

    const error = await http.get("/x/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlagsmithApiError);
    expect(error).toMatchObject({
      status: 400,
      retryable: false,
      body: { name: ["already exists"] },
    });
    expect((error as Error).message).toMatch(/already exists/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("wraps network failures and gives up after maxRetries", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError("fetch failed")));
    const { http } = client(fetch);

    await expect(http.get("/x/")).rejects.toThrow(/fetch failed/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
