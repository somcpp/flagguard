import { type FetchLike } from "@flagguard/core";
import { describe, expect, it, vi } from "vitest";
import { findFlagInComments, flagMarker, GitHubClient, parseSlashCommand } from "../src/github.js";

describe("parseSlashCommand", () => {
  it.each([
    ["/flagguard approve", "approve", ""],
    ["/flagguard kill errors spiking in EU", "kill", "errors spiking in EU"],
    ["  /FlagGuard Status", "status", ""],
    ["/flagguard", "help", ""],
    ["/flagguard deploy-everything", "help", ""],
  ])("parses %j", (body, command, args) => {
    expect(parseSlashCommand(body)).toEqual({ command, args });
  });

  it("ignores comments that are not commands", () => {
    expect(parseSlashCommand("LGTM, ship it")).toBeNull();
    expect(parseSlashCommand("please run\n/flagguard approve")).toBeNull();
  });
});

describe("flag marker", () => {
  it("round-trips the flag name through a comment", () => {
    const comments = [
      { id: 1, body: "hello", user: { login: "a", type: "User" } },
      {
        id: 2,
        body: `report\n${flagMarker("fg_new_checkout")}`,
        user: { login: "bot", type: "Bot" },
      },
    ];
    expect(findFlagInComments(comments)).toBe("fg_new_checkout");
    expect(findFlagInComments([])).toBeNull();
  });
});

describe("GitHubClient", () => {
  const ok = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it("updates the existing report comment instead of posting a new one", async () => {
    const fetch = vi.fn<FetchLike>((url, init) => {
      if (init?.method === "GET")
        return ok([{ id: 7, body: "<!-- m --> old", user: { login: "bot", type: "Bot" } }]);
      return ok({ id: 7 });
    });
    const github = new GitHubClient("t", "o/r", { fetch });

    expect(await github.upsertComment(3, "<!-- m -->", "new")).toEqual({ id: 7, created: false });
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(url).toBe("https://api.github.com/repos/o/r/issues/comments/7");
    expect(init?.method).toBe("PATCH");
  });

  it("posts multi-line suggestions anchored to the right side of the diff", async () => {
    const fetch = vi.fn<FetchLike>(() => ok({}));
    const github = new GitHubClient("t", "o/r", { fetch });
    await github.suggest(3, "abc123", "fg_x", [
      { file: "a.ts", startLine: 2, endLine: 4, replacement: "new()\n", explanation: "wrap" },
    ]);

    const body = JSON.parse(fetch.mock.calls[0]![1]?.body as string) as {
      commit_id: string;
      comments: Record<string, unknown>[];
    };
    expect(body.commit_id).toBe("abc123");
    expect(body.comments[0]).toMatchObject({ path: "a.ts", line: 4, start_line: 2, side: "RIGHT" });
    expect(String(body.comments[0]?.body)).toContain("```suggestion\nnew()\n```");
  });

  it("surfaces API errors with status and path", async () => {
    const github = new GitHubClient("t", "o/r", {
      fetch: () => Promise.resolve(new Response("Not Found", { status: 404 })),
    });
    await expect(github.getPull(1)).rejects.toThrow(/GET \/repos\/o\/r\/pulls\/1 failed with 404/);
  });
});

describe("typo tolerance", () => {
  it("accepts near-miss prefixes and records the misspelling", () => {
    expect(parseSlashCommand("/flaggaurd status")).toEqual({
      command: "status",
      args: "",
      misspelledAs: "/flaggaurd",
    });
    expect(parseSlashCommand("/flagard approve")?.command).toBe("approve");
  });

  it("ignores unrelated slash commands", () => {
    expect(parseSlashCommand("/flags list")).toBeNull();
    expect(parseSlashCommand("/flagsmith status")).toBeNull();
    expect(parseSlashCommand("/deploy now")).toBeNull();
  });
});
