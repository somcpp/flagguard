import { readFile } from "node:fs/promises";
import { type CodeSuggestion, FlagGuardError, type FetchLike } from "@flagguard/core";

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

/** Minimal GitHub REST client for what the Action needs. */
export class GitHubClient {
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly token: string,
    private readonly repo: string,
    options: { apiUrl?: string; fetch?: FetchLike } = {},
  ) {
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  getPull(number: number): Promise<PullRequest> {
    return this.json("GET", `/repos/${this.repo}/pulls/${number}`);
  }

  async getPullDiff(number: number): Promise<string> {
    const response = await this.request("GET", `/repos/${this.repo}/pulls/${number}`, undefined, {
      Accept: "application/vnd.github.diff",
    });
    return response.text();
  }

  async listIssueComments(number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json<IssueComment[]>(
        "GET",
        `/repos/${this.repo}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return comments;
  }

  /** Raw file contents at a commit, or null if missing/binary/too large. */
  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const response = await this.request(
        "GET",
        `/repos/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        undefined,
        { Accept: "application/vnd.github.raw" },
      );
      return await response.text();
    } catch {
      return null;
    }
  }

  listReviewComments(number: number): Promise<ReviewComment[]> {
    return this.json("GET", `/repos/${this.repo}/pulls/${number}/comments?per_page=100`);
  }

  /** Collapse a comment as outdated (non-destructive; it can be expanded again). */
  async minimizeAsOutdated(nodeId: string): Promise<void> {
    await this.json("POST", "/graphql", {
      query:
        "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }",
      variables: { id: nodeId },
    });
  }

  createComment(number: number, body: string): Promise<IssueComment> {
    return this.json("POST", `/repos/${this.repo}/issues/${number}/comments`, { body });
  }

  updateComment(id: number, body: string): Promise<IssueComment> {
    return this.json("PATCH", `/repos/${this.repo}/issues/comments/${id}`, { body });
  }

  /** Create or update the comment carrying `marker`, so each PR has one living report. */
  async upsertComment(
    number: number,
    marker: string,
    body: string,
  ): Promise<{ id: number; created: boolean }> {
    const existing = (await this.listIssueComments(number)).find((c) => c.body.includes(marker));
    if (existing) {
      await this.updateComment(existing.id, body);
      return { id: existing.id, created: false };
    }
    const created = await this.createComment(number, body);
    return { id: created.id, created: true };
  }

  async react(commentId: number, content: "eyes" | "+1" | "-1" | "rocket"): Promise<void> {
    await this.request("POST", `/repos/${this.repo}/issues/comments/${commentId}/reactions`, {
      content,
    });
  }

  /** Post code suggestions as one review; reviewers can commit each with a click. */
  async suggest(
    number: number,
    commitId: string,
    flag: string,
    suggestions: CodeSuggestion[],
  ): Promise<void> {
    if (suggestions.length === 0) return;
    await this.json("POST", `/repos/${this.repo}/pulls/${number}/reviews`, {
      commit_id: commitId,
      event: "COMMENT",
      body: `🛡️ **FlagGuard**: ${suggestions.length} suggestion(s) to ship the new behaviour behind \`${flag}\`. With the flag off, the old code path runs.`,
      comments: suggestions.map((s) => ({
        path: s.file,
        line: s.endLine,
        side: "RIGHT",
        ...(s.startLine < s.endLine ? { start_line: s.startLine, start_side: "RIGHT" } : {}),
        body: `<!-- flagguard:suggestion -->\n💡 ${s.explanation}\n\n\`\`\`suggestion\n${s.replacement.replace(/\n$/, "")}\n\`\`\``,
      })),
    });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    return (await response.json()) as T;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "flagguard",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new FlagGuardError(
        "GITHUB_API_ERROR",
        `GitHub ${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    return response;
  }
}

export interface ReviewComment {
  id: number;
  node_id: string;
  body: string;
}

export interface GitHubEvent {
  name: string;
  payload: {
    action?: string;
    number?: number;
    pull_request?: PullRequest;
    issue?: { number: number; pull_request?: unknown };
    comment?: IssueComment & { author_association: string };
  };
}

export async function readGitHubEvent(env: NodeJS.ProcessEnv = process.env): Promise<GitHubEvent> {
  const name = env.GITHUB_EVENT_NAME;
  const path = env.GITHUB_EVENT_PATH;
  if (!name || !path) {
    throw new FlagGuardError(
      "CONFIG_INVALID",
      "Not running in GitHub Actions (GITHUB_EVENT_NAME/GITHUB_EVENT_PATH unset)",
    );
  }
  return { name, payload: JSON.parse(await readFile(path, "utf8")) as GitHubEvent["payload"] };
}

export const COMMANDS = ["status", "approve", "reject", "kill", "help"] as const;
export type SlashCommand = (typeof COMMANDS)[number];

/** Parse `/flagguard <command> [reason...]` from the first line of a comment. */
export function parseSlashCommand(body: string): { command: SlashCommand; args: string } | null {
  const match = /^\s*\/flagguard(?:\s+(\S+))?(?:\s+(.*))?$/im.exec(body.split("\n")[0] ?? "");
  if (!match) return null;
  const command = (match[1] ?? "help").toLowerCase();
  return {
    command: (COMMANDS as readonly string[]).includes(command) ? (command as SlashCommand) : "help",
    args: (match[2] ?? "").trim(),
  };
}

/** Only people with write-level association may change production. */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Flag name recorded in the guard comment: `<!-- flagguard:flag=fg_x -->`. */
export function flagMarker(flag: string): string {
  return `<!-- flagguard:flag=${flag} -->`;
}

export function findFlagInComments(comments: IssueComment[]): string | null {
  for (const comment of comments) {
    const match = /<!-- flagguard:flag=([a-z0-9_]+) -->/.exec(comment.body);
    if (match?.[1]) return match[1];
  }
  return null;
}
