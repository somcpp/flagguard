import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { ConfigError } from "../src/errors.js";

describe("loadEnv", () => {
  it("parses a minimal valid environment and applies defaults", () => {
    const env = loadEnv({ FLAGSMITH_API_KEY: "key", FLAGSMITH_PROJECT_ID: "42" });

    expect(env.FLAGSMITH_PROJECT_ID).toBe(42);
    expect(env.FLAGSMITH_API_URL).toBe("https://api.flagsmith.com");
    expect(env.LLM_PROVIDER).toBe("gemini");
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("treats blank values (as copied from .env.example) as missing", () => {
    const env = loadEnv({
      FLAGSMITH_API_KEY: "key",
      FLAGSMITH_PROJECT_ID: "1",
      FLAGSMITH_API_URL: "",
      LLM_API_KEY: "  ",
    });
    expect(env.FLAGSMITH_API_URL).toBe("https://api.flagsmith.com");
    expect(env.LLM_API_KEY).toBeUndefined();
  });

  it("explains every problem at once", () => {
    let error: unknown;
    try {
      loadEnv({ FLAGSMITH_PROJECT_ID: "abc", LOG_LEVEL: "loud" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toMatch(/FLAGSMITH_API_KEY/);
    expect(message).toMatch(/FLAGSMITH_PROJECT_ID/);
    expect(message).toMatch(/LOG_LEVEL/);
  });
});
