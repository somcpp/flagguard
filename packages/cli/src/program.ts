import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import {
  createFlagsmith,
  type EngineResult,
  FlagGuardError,
  human,
  HttpMetricsSource,
  KeyhopperClient,
  loadEnv,
} from "@flagguard/core";
import { Command, Option } from "commander";
import pc from "picocolors";
import { type Context, createCliLogger, createContext, type GlobalOptions } from "./context.js";
import { formatAudit, formatHealth, formatResult, formatStatus } from "./format.js";
import { guardLocal, llmFromEnv, runGitHub } from "./guard-commands.js";

export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const consoleIO: IO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};

/** Exit codes, so CI pipelines can branch on the outcome. */
export const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3 } as const;

const STARTER_POLICY = `# FlagGuard policy: https://github.com/somcpp/flagguard/blob/main/flagguard.example.yml
version: 1

environments:
  - name: Development
  - name: Staging
  - name: Production
    production: true

rollout:
  stages: [5, 25, 50, 100]
  minStageMinutes: 10

guardrails:
  minSamples: 50
  maxErrorRate: 0.05
  maxErrorRateRatio: 2
  maxLatencyRatio: 1.5
`;

function defaultActor(): string {
  try {
    return process.env.FLAGGUARD_USER ?? userInfo().username;
  } catch {
    return "cli";
  }
}

export function createProgram(
  io: IO = consoleIO,
  contextFactory: (options: GlobalOptions) => Promise<Context> = (o) => createContext(o),
): Command {
  const program = new Command("flagguard")
    .description(
      "Gated, self-healing Flagsmith rollouts. The agent acts alone only when that reduces risk.",
    )
    .version("0.1.0")
    .option("--policy <path>", "path to flagguard.yml (default: auto-detect)")
    .option("--offline <shopUrl>", "drive the demo shop's offline rollout instead of Flagsmith")
    .option("--metrics <url>", "app exposing /flagguard/metrics/:flag (env FLAGGUARD_METRICS_URL)")
    .option("--state-dir <dir>", "where state and the audit log live", ".flagguard")
    .option("--json", "machine-readable output")
    .option("--verbose", "show debug logs from the Flagsmith client")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => {
        io.out(s.trimEnd());
      },
      writeErr: (s) => {
        io.err(s.trimEnd());
      },
    });

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const env = (): Option =>
    new Option("-e, --env <name>", "environment (default: first production environment)");
  const as = (): Option =>
    new Option("--as <name>", "who is acting (default: $FLAGGUARD_USER or OS user)").default(
      defaultActor(),
    );

  /** Run a command with uniform error handling and exit codes. */
  const run =
    <A extends unknown[]>(handler: (ctx: Context, ...args: A) => Promise<number | undefined>) =>
    async (...args: A): Promise<void> => {
      try {
        const ctx = await contextFactory(globals());
        process.exitCode = (await handler(ctx, ...args)) ?? EXIT.ok;
      } catch (error) {
        io.err(pc.red(`✖ ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode =
          error instanceof FlagGuardError && error.code === "CONFIG_INVALID"
            ? EXIT.usage
            : EXIT.error;
      }
    };

  const emit = (data: unknown, render: () => string): void => {
    io.out(globals().json ? JSON.stringify(data, null, 2) : render());
  };

  const exitFor = (result: EngineResult): number =>
    result.outcome === "blocked" || result.outcome === "denied" ? EXIT.blocked : EXIT.ok;

  const targetEnv = (ctx: Context, requested?: string): string =>
    requested ?? ctx.engine.defaultEnvironment();

  /* ---------------------------------- setup ---------------------------------- */

  program
    .command("init")
    .description("write a starter flagguard.yml")
    .action(async () => {
      const file = path.resolve("flagguard.yml");
      if (existsSync(file)) {
        io.err(pc.yellow(`flagguard.yml already exists at ${file}`));
        process.exitCode = EXIT.usage;
        return;
      }
      await writeFile(file, STARTER_POLICY, "utf8");
      io.out(pc.green(`✔ wrote ${file}`));
    });

  program
    .command("doctor")
    .description("check configuration, Flagsmith access and the metrics endpoint")
    .action(async () => {
      let problems = 0;
      const ok = (msg: string): void => {
        io.out(`${pc.green("✔")} ${msg}`);
      };
      const bad = (msg: string): void => {
        problems++;
        io.out(`${pc.red("✖")} ${msg}`);
      };

      let ctx: Context;
      try {
        ctx = await contextFactory(globals());
      } catch (error) {
        bad((error as Error).message);
        process.exitCode = EXIT.usage;
        return;
      }
      ok(ctx.envFile ? `loaded ${ctx.envFile}` : "no .env file found (using process environment)");
      ok(
        ctx.loaded.path ? `policy ${ctx.loaded.path}` : "no flagguard.yml, using built-in defaults",
      );
      ok(`backend: ${ctx.backend.kind}`);

      if (ctx.backend.kind === "flagsmith") {
        try {
          const settings = loadEnv();
          const { client } = createFlagsmith(settings);
          const project = await client.getProject(settings.FLAGSMITH_PROJECT_ID);
          ok(`Flagsmith project "${project.name}" (id ${project.id}) reachable`);
          const remote = await client.listEnvironments(settings.FLAGSMITH_PROJECT_ID);
          for (const env of ctx.loaded.policy.environments) {
            const match = remote.find((r) => r.name.toLowerCase() === env.name.toLowerCase());
            if (match) {
              ok(
                `environment ${env.name}${env.production ? " (production)" : ""}${match.use_v2_feature_versioning ? pc.dim(" · v2 versioning") : ""}`,
              );
            } else bad(`environment "${env.name}" from flagguard.yml does not exist in Flagsmith`);
          }
        } catch (error) {
          bad(`Flagsmith: ${(error as Error).message}`);
        }
      }

      if (ctx.metricsUrl) {
        try {
          await new HttpMetricsSource(ctx.metricsUrl).snapshot("__doctor__");
          ok(`metrics endpoint ${ctx.metricsUrl}/flagguard/metrics/:flag`);
        } catch (error) {
          bad((error as Error).message);
        }
      } else {
        io.out(
          `${pc.yellow("!")} no metrics URL: health gates and the watcher are disabled (use --metrics)`,
        );
      }

      try {
        const llm = llmFromEnv();
        if (!llm) {
          io.out(`${pc.yellow("!")} no LLM keys: risk analysis will use rules only`);
        } else if (llm instanceof KeyhopperClient) {
          const providers = llm.describe();
          ok(
            `LLM via keyhopper: ${providers.map((p) => `${p.provider} (${p.keys} key${p.keys === 1 ? "" : "s"})`).join(" → ")}`,
          );
          for (const result of await llm.check()) {
            const label = `${result.provider}/${result.model} [${result.key}]`;
            if (result.ok) ok(`  ${label} ${pc.dim(`${String(result.ms ?? "?")}ms`)}`);
            else
              io.out(`${pc.yellow("!")}   ${label} ${result.status ?? ""} ${result.error ?? ""}`);
          }
        } else {
          ok(`LLM: ${llm.provider} (${llm.model})`);
        }
      } catch (error) {
        bad(`LLM: ${(error as Error).message}`);
      }
      io.out(problems === 0 ? pc.green("\nAll good.") : pc.red(`\n${problems} problem(s) found.`));
      process.exitCode = problems === 0 ? EXIT.ok : EXIT.error;
    });

  /* ---------------------------------- flags ---------------------------------- */

  const flag = program.command("flag").description("manage flags");
  flag
    .command("create <flag>")
    .description("create a flag: off in production, on in every other environment")
    .option("-d, --description <text>", "what the flag guards", "Created by FlagGuard")
    .action(
      run(async (ctx, name: string, opts: { description: string }) => {
        const results = await ctx.engine.createFlag(name, opts.description);
        emit(results, () =>
          results
            .map((r) => `${pc.bold(r.record.environment.padEnd(12))} ${formatResult(r)}`)
            .join("\n"),
        );
        return EXIT.ok;
      }),
    );

  program
    .command("status <flag>")
    .description("rollout state of a flag in every environment")
    .action(
      run(async (ctx, name: string) => {
        const records = await ctx.engine.status(name);
        const production = new Set(
          ctx.engine
            .environments()
            .filter((e) => e.production)
            .map((e) => e.name),
        );
        emit(records, () => `${pc.bold(name)}\n${formatStatus(records, production)}`);
        return EXIT.ok;
      }),
    );

  /* --------------------------------- rollout --------------------------------- */

  program
    .command("advance <flag>")
    .description("move to the next rollout stage now (you are the approver)")
    .addOption(env())
    .addOption(as())
    .option("--force", "skip the minimum stage time and data gates (never the health gate)")
    .action(
      run(async (ctx, name: string, opts: { env?: string; as: string; force?: boolean }) => {
        const result = await ctx.engine.advance(name, targetEnv(ctx, opts.env), human(opts.as), {
          force: opts.force ?? false,
        });
        emit(result, () => formatResult(result));
        return exitFor(result);
      }),
    );

  program
    .command("propose <flag>")
    .description("ask the agent to propose the next stage (creates a pending approval)")
    .addOption(env())
    .action(
      run(async (ctx, name: string, opts: { env?: string }) => {
        const result = await ctx.engine.advance(name, targetEnv(ctx, opts.env), "agent");
        emit(result, () => formatResult(result));
        return exitFor(result);
      }),
    );

  program
    .command("approve <flag>")
    .description("approve the pending action for a flag")
    .addOption(env())
    .addOption(as())
    .action(
      run(async (ctx, name: string, opts: { env?: string; as: string }) => {
        const result = await ctx.engine.approve(name, targetEnv(ctx, opts.env), human(opts.as));
        emit(result, () => formatResult(result));
        return exitFor(result);
      }),
    );

  program
    .command("reject <flag>")
    .description("reject the pending action for a flag")
    .addOption(env())
    .addOption(as())
    .option("-r, --reason <text>", "why")
    .action(
      run(async (ctx, name: string, opts: { env?: string; as: string; reason?: string }) => {
        const result = await ctx.engine.reject(
          name,
          targetEnv(ctx, opts.env),
          human(opts.as),
          opts.reason,
        );
        emit(result, () => formatResult(result));
        return EXIT.ok;
      }),
    );

  program
    .command("approvals")
    .description("list actions waiting for a human")
    .action(
      run(async (ctx) => {
        const pending = await ctx.engine.pendingApprovals();
        emit(pending, () =>
          pending.length === 0
            ? pc.dim("Nothing is waiting for approval.")
            : pending
                .map(
                  (r) =>
                    `${pc.yellow("⏳")} ${pc.bold(r.flag)} ${pc.dim(r.environment)}  ${r.pendingApproval?.reason ?? ""}\n   ${pc.dim("→")} flagguard approve ${r.flag} --env ${r.environment}`,
                )
                .join("\n"),
        );
        return EXIT.ok;
      }),
    );

  program
    .command("kill <flag>")
    .description("kill switch: turn the flag off for everyone in an environment")
    .addOption(env())
    .addOption(as())
    .option("-r, --reason <text>", "why", "Manual kill switch")
    .action(
      run(async (ctx, name: string, opts: { env?: string; as: string; reason: string }) => {
        const result = await ctx.engine.kill(
          name,
          targetEnv(ctx, opts.env),
          human(opts.as),
          opts.reason,
        );
        emit(result, () => formatResult(result));
        return exitFor(result);
      }),
    );

  /* ---------------------------------- watch ---------------------------------- */

  program
    .command("watch <flag>")
    .description("watch cohort health and pull the kill switch on a regression")
    .addOption(env())
    .option("-i, --interval <seconds>", "seconds between checks", "5")
    .option("--propose", "also propose the next stage when the current one is healthy")
    .option("--once", "run a single check and exit")
    .action(
      run(
        async (
          ctx,
          name: string,
          opts: { env?: string; interval: string; propose?: boolean; once?: boolean },
        ) => {
          if (!ctx.metricsUrl) {
            io.err(
              pc.red(
                "watch needs a metrics source: pass --metrics <url> or set FLAGGUARD_METRICS_URL",
              ),
            );
            return EXIT.usage;
          }
          const environment = targetEnv(ctx, opts.env);
          const interval = Math.max(1, Number(opts.interval) || 5) * 1000;
          if (!opts.once && !globals().json) {
            io.out(
              `👀 Watching ${pc.bold(name)} in ${pc.bold(environment)} every ${interval / 1000}s (Ctrl+C to stop)`,
            );
          }

          let lastProposal: string | undefined;
          const tick = async (): Promise<void> => {
            const result = await ctx.engine.checkHealth(name, environment);
            const time = pc.dim(new Date().toLocaleTimeString());
            emit(
              result,
              () =>
                `${time}  ${String(result.percentageAtCheck).padStart(3)}%  ${formatHealth(result.verdict)}`,
            );

            if (result.action === "killed") {
              io.out(
                pc.bold(
                  pc.bgRed(pc.white(` 🛑 KILL SWITCH PULLED: ${name} is OFF in ${environment} `)),
                ),
              );
              io.out(pc.red(`   ${result.verdict.summary}`));
            } else if (result.action === "kill_requested") {
              io.out(
                pc.yellow(
                  `⏳ Kill requested; policy requires approval: flagguard approve ${name} --env ${environment}`,
                ),
              );
            } else if (
              opts.propose &&
              result.verdict.status === "healthy" &&
              result.record.status === "in_progress"
            ) {
              const proposal = await ctx.engine.advance(name, environment, "agent");
              if (
                proposal.outcome === "pending_approval" &&
                proposal.approval?.id !== lastProposal
              ) {
                lastProposal = proposal.approval?.id;
                io.out(formatResult(proposal));
              }
            }
          };

          await tick();
          if (opts.once) return EXIT.ok;
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              tick().catch((error: unknown) => {
                io.err(pc.red(`✖ ${(error as Error).message}`));
              });
            }, interval);
            process.once("SIGINT", () => {
              clearInterval(timer);
              resolve();
            });
          });
          return EXIT.ok;
        },
      ),
    );

  /* ---------------------------------- guard ---------------------------------- */

  program
    .command("guard")
    .description("review a diff for risk and propose a flag (default: current branch vs main)")
    .option("--diff <file>", "read the diff from a file, or - for stdin")
    .option("--base <ref>", "git ref to diff against", "main")
    .option("--title <text>", "pull request title for context")
    .option("--apply", "create the flag in Flagsmith (otherwise a dry run)")
    .option("--no-ai", "skip the LLM review and use rules only")
    .action(
      async (opts: {
        diff?: string;
        base: string;
        title?: string;
        apply?: boolean;
        ai: boolean;
      }) => {
        try {
          const { report, markdown } = await guardLocal(
            { ...globals(), ...opts, noAi: !opts.ai },
            contextFactory,
            createCliLogger(globals().verbose ? "debug" : "warn"),
          );
          emit(report, () => markdown);
          process.exitCode = EXIT.ok;
        } catch (error) {
          io.err(pc.red(`✖ ${(error as Error).message}`));
          process.exitCode = EXIT.error;
        }
      },
    );

  program
    .command("github")
    .description("GitHub Action entry point: review PRs and handle /flagguard comments")
    .option("--dry-run", "review and comment, but never change Flagsmith")
    .action(async (opts: { dryRun?: boolean }) => {
      try {
        const result = await runGitHub(
          { ...globals(), ...opts },
          contextFactory,
          createCliLogger(globals().verbose ? "debug" : "info"),
        );
        io.out(`✔ ${result.summary}`);
        process.exitCode = EXIT.ok;
      } catch (error) {
        io.err(pc.red(`✖ ${(error as Error).message}`));
        process.exitCode = EXIT.error;
      }
    });

  /* ---------------------------------- audit ---------------------------------- */

  program
    .command("audit [flag]")
    .description("show what the agent did, and why")
    .addOption(new Option("-n, --limit <n>", "most recent N events").default("20"))
    .addOption(new Option("-e, --env <name>", "only this environment"))
    .action(
      run(async (ctx, name: string | undefined, opts: { limit: string; env?: string }) => {
        const events = await ctx.audit.list({
          ...(name ? { flag: name } : {}),
          ...(opts.env ? { environment: opts.env } : {}),
          limit: Number(opts.limit) || 20,
        });
        emit(events, () =>
          events.length === 0 ? pc.dim("No events yet.") : events.map(formatAudit).join("\n"),
        );
        return EXIT.ok;
      }),
    );

  return program;
}
