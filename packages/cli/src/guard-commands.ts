import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  analyzePullRequest,
  type FileContext,
  isGenericFlagName,
  parseUnifiedDiff,
  createLlmClient,
  EnvSchema,
  type EngineResult,
  GUARD_COMMENT_MARKER,
  type GuardReport,
  human,
  type LlmClient,
  loadDotEnv,
  loadPolicy,
  type Logger,
  type Policy,
  renderCommandReply,
  renderGuardComment,
  renderStatusTable,
} from "@flagguard/core";
import type { Context, GlobalOptions } from "./context.js";
import {
  findFlagInComments,
  flagMarker,
  GitHubClient,
  type GitHubEvent,
  parseSlashCommand,
  readGitHubEvent,
  TRUSTED_ASSOCIATIONS,
} from "./github.js";

const run = promisify(execFile);

export function llmFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger,
): LlmClient | null {
  const parsed = EnvSchema.pick({
    LLM_PROVIDER: true,
    LLM_API_KEY: true,
    LLM_MODEL: true,
    LLM_BASE_URL: true,
  }).parse(env);
  return createLlmClient(parsed, { env, ...(logger ? { logger } : {}) });
}

const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_FILE_CHARS = 30_000;

/** Full new-file contents of changed (non-deleted) files, for the AI's context. */
async function fileContext(
  files: ReturnType<typeof parseUnifiedDiff>,
  read: (path: string) => Promise<string | null>,
): Promise<FileContext> {
  const paths = files
    .filter((f) => f.status !== "deleted")
    .slice(0, MAX_CONTEXT_FILES)
    .map((f) => f.path);
  const contents = await Promise.all(paths.map(read));
  const context: FileContext = {};
  paths.forEach((path, i) => {
    const content = contents[i];
    if (content && content.length <= MAX_CONTEXT_FILE_CHARS) context[path] = content;
  });
  return context;
}

async function readDiff(options: { diff?: string; base: string }): Promise<string> {
  if (options.diff === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (options.diff) return readFile(options.diff, "utf8");
  const { stdout } = await run("git", ["diff", "--no-color", `${options.base}...HEAD`], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function currentBranch(): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `flagguard guard`: analyse a local diff (defaults to the current branch vs main). */
export async function guardLocal(
  options: GlobalOptions & {
    diff?: string;
    base: string;
    title?: string;
    apply?: boolean;
    noAi?: boolean;
  },
  contextFactory: (o: GlobalOptions) => Promise<Context>,
  logger: Logger,
): Promise<{ report: GuardReport; markdown: string }> {
  loadDotEnv();
  const { policy } = await loadPolicy(options.policy ? { explicitPath: options.policy } : {});
  const diff = await readDiff(options);
  const context = await fileContext(parseUnifiedDiff(diff), async (path) => {
    try {
      const { stdout } = await run("git", ["show", `HEAD:${path}`], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  });
  const report = await analyzePullRequest({
    diff,
    context,
    pr: { title: options.title ?? "Local changes", branch: await currentBranch() },
    policy,
    llm: options.noAi ? null : llmFromEnv(process.env, logger),
    logger,
  });

  let flagResults: EngineResult[] | undefined;
  if (options.apply && report.flag) {
    const ctx = await contextFactory(options);
    flagResults = await ctx.engine.createFlag(report.flag.name, report.flag.description);
  }
  const markdown = renderGuardComment({
    report,
    policy,
    ...(flagResults ? { flagResults } : { dryRun: true }),
  });
  return { report, markdown };
}

export interface GitHubRunResult {
  event: string;
  summary: string;
}

/**
 * `flagguard github`: entry point for the GitHub Action.
 * - pull_request: review the diff, create the flag, post or refresh the report, suggest code
 * - issue_comment: run `/flagguard <command>` from trusted collaborators
 */
export async function runGitHub(
  options: GlobalOptions & { dryRun?: boolean },
  contextFactory: (o: GlobalOptions) => Promise<Context>,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubRunResult> {
  loadDotEnv();
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const github = new GitHubClient(
    token,
    repo,
    env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {},
  );
  const event = await readGitHubEvent(env);
  const { policy } = await loadPolicy(options.policy ? { explicitPath: options.policy } : {});

  // Without Flagsmith credentials (e.g. PRs from forks) review only and change nothing.
  let ctx: Context | null = null;
  if (!options.dryRun) {
    try {
      ctx = await contextFactory(options);
    } catch (error) {
      logger.warn("Flagsmith not configured; running as dry run", {
        error: (error as Error).message,
      });
    }
  }

  if (event.name === "pull_request" || event.name === "pull_request_target") {
    return onPullRequest(event, github, policy, ctx, logger, env);
  }
  if (event.name === "issue_comment") {
    return onComment(event, github, policy, ctx);
  }
  return { event: event.name, summary: `Ignored event ${event.name}` };
}

async function onPullRequest(
  event: GitHubEvent,
  github: GitHubClient,
  policy: Policy,
  ctx: Context | null,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<GitHubRunResult> {
  const pr = event.payload.pull_request;
  if (!pr) throw new Error("pull_request payload missing");

  const diff = await github.getPullDiff(pr.number);
  const context = await fileContext(parseUnifiedDiff(diff), (path) =>
    github.getFileContent(path, pr.head.sha),
  );
  const report = await analyzePullRequest({
    diff,
    pr: { title: pr.title, body: pr.body ?? undefined, number: pr.number, branch: pr.head.ref },
    policy,
    llm: llmFromEnv(env, logger),
    context,
    logger,
  });

  // Keep the flag name stable across pushes: reuse the one already announced on this PR,
  // unless it was a meaningless name, which gets replaced.
  const comments = await github.listIssueComments(pr.number);
  const known = findFlagInComments(comments);
  if (report.flag && known && !isGenericFlagName(known, policy.flags.prefix)) {
    const fresh = report.flag.name;
    report.flag.name = known;
    for (const s of report.suggestions) s.replacement = s.replacement.replaceAll(fresh, known);
  }

  const flagResults =
    ctx && report.flag
      ? await ctx.engine.createFlag(report.flag.name, report.flag.description)
      : undefined;

  const body =
    renderGuardComment({ report, policy, ...(flagResults ? { flagResults } : { dryRun: true }) }) +
    (report.flag ? `\n${flagMarker(report.flag.name)}` : "");
  const { created } = await github.upsertComment(pr.number, GUARD_COMMENT_MARKER, body);

  // Inline suggestions, derived from the review comments themselves (stateless):
  // - suggestions for another flag name (e.g. before a rename) are hidden as outdated, never deleted
  // - suggestions for the current flag are posted once, not on every push
  try {
    const flagName = report.flag?.name;
    const ours = (await github.listReviewComments(pr.number)).filter((c) =>
      c.body.includes("<!-- flagguard:suggestion -->"),
    );
    for (const old of ours) {
      if (!flagName || !old.body.includes(flagName)) await github.minimizeAsOutdated(old.node_id);
    }
    const alreadySuggested = flagName ? ours.some((c) => c.body.includes(flagName)) : false;
    if (flagName && report.suggestions.length > 0 && !alreadySuggested) {
      await github.suggest(pr.number, pr.head.sha, flagName, report.suggestions);
    }
  } catch (error) {
    logger.warn("could not update code suggestions", { error: (error as Error).message });
  }

  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, body + "\n");
  return {
    event: "pull_request",
    summary: `${created ? "Posted" : "Updated"} review on #${pr.number}: risk ${report.score}/100${report.flag ? `, flag ${report.flag.name}` : ""}`,
  };
}

async function onComment(
  event: GitHubEvent,
  github: GitHubClient,
  policy: Policy,
  ctx: Context | null,
): Promise<GitHubRunResult> {
  const { issue, comment } = event.payload;
  if (!issue?.pull_request || !comment)
    return { event: "issue_comment", summary: "Not a PR comment" };
  if (comment.user.type === "Bot")
    return { event: "issue_comment", summary: "Ignoring bot comment" };
  const parsed = parseSlashCommand(comment.body);
  if (!parsed) return { event: "issue_comment", summary: "No /flagguard command" };

  const reply = async (title: string, body: string): Promise<GitHubRunResult> => {
    await github.createComment(issue.number, renderCommandReply(parsed.command, [{ title, body }]));
    return { event: "issue_comment", summary: `${parsed.command}: ${title}` };
  };

  await github.react(comment.id, "eyes");

  if (
    parsed.command !== "status" &&
    parsed.command !== "help" &&
    !TRUSTED_ASSOCIATIONS.has(comment.author_association)
  ) {
    await github.react(comment.id, "-1");
    return reply(
      "Not allowed",
      `@${comment.user.login} only repository owners, members and collaborators can change rollouts.`,
    );
  }

  const flag = findFlagInComments(await github.listIssueComments(issue.number));
  if (!flag)
    return reply(
      "No flag on this PR",
      "FlagGuard didn't put this change behind a flag, so there's nothing to manage.",
    );
  if (parsed.command === "help") {
    return reply(
      "Commands",
      "`/flagguard status` · `/flagguard approve` · `/flagguard reject [reason]` · `/flagguard kill [reason]`",
    );
  }
  if (!ctx)
    return reply(
      "Flagsmith not configured",
      "Add `FLAGSMITH_API_KEY` and `FLAGSMITH_PROJECT_ID` secrets to manage rollouts from PR comments.",
    );

  const environment = ctx.engine.defaultEnvironment();
  const actor = human(comment.user.login);

  switch (parsed.command) {
    case "status": {
      return reply(`\`${flag}\``, renderStatusTable(await ctx.engine.status(flag), policy));
    }
    case "approve": {
      // A trusted human commanding the next stage *is* the approval; health is still checked.
      const result = await ctx.engine.advance(flag, environment, actor);
      await github.react(comment.id, result.outcome === "applied" ? "rocket" : "-1");
      const health = result.health
        ? `\n\nHealth: ${result.health.status} · ${result.health.summary}`
        : "";
      return reply(
        result.outcome === "applied"
          ? `✅ ${result.message}`
          : `⛔ ${result.outcome.replace("_", " ")}`,
        `${result.outcome === "applied" ? `Approved by @${comment.user.login}.` : result.message}${health}\n\n${renderStatusTable(await ctx.engine.status(flag), policy)}`,
      );
    }
    case "reject": {
      await github.react(comment.id, "+1");
      return reply(
        "Noted",
        `@${comment.user.login} declined the next stage${parsed.args ? `: ${parsed.args}` : ""}. Nothing changed in Flagsmith.`,
      );
    }
    case "kill": {
      await ctx.engine.kill(
        flag,
        environment,
        actor,
        parsed.args || `Kill switch from PR comment by @${comment.user.login}`,
      );
      await github.react(comment.id, "+1");
      return reply(
        `🛑 \`${flag}\` is OFF in ${environment}`,
        renderStatusTable(await ctx.engine.status(flag), policy),
      );
    }
  }
}
