# @flagguard/cli

`flagguard`: gated, self-healing Flagsmith rollouts from your terminal or CI.

```bash
npm run build
npm run flagguard -- --help     # from the repository root
```

## Commands

| Command                                      | What it does                                                                                                     | Who acts |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| `flagguard doctor`                           | Checks `.env`, `flagguard.yml`, Flagsmith access, environments and the metrics endpoint                          |          |
| `flagguard init`                             | Writes a starter `flagguard.yml`                                                                                 |          |
| `flagguard flag create <flag>`               | Creates the flag, on in non-production, off in production                                                        | 🤖       |
| `flagguard status <flag>`                    | Rollout percentage and state per environment                                                                     |          |
| `flagguard propose <flag>`                   | Agent proposes the next stage, which creates a pending approval                                                  | 🤖 asks  |
| `flagguard approvals`                        | Lists everything waiting for a human                                                                             |          |
| `flagguard approve <flag>` / `reject <flag>` | Resolve the pending action (health is re-checked first)                                                          | 🧑       |
| `flagguard advance <flag>`                   | Move to the next stage now (you are the approver)                                                                | 🧑       |
| `flagguard kill <flag>`                      | Kill switch: off for everyone in the environment                                                                 | 🧑       |
| `flagguard watch <flag>`                     | Watches cohort health and kills the flag on a regression. `--propose` also proposes the next stage while healthy | 🤖       |
| `flagguard dashboard`                        | Local web UI with approvals, rollout, health charts and activity. `--watch` runs the agent loop                  | 🤖 + 🧑  |
| `flagguard audit [flag]`                     | What happened, who did it, and why                                                                               |          |

Most commands take `-e, --env <name>`. It defaults to the first production environment in
`flagguard.yml`. `--as <name>` records who approved; it defaults to `$FLAGGUARD_USER` or your OS user.

## Global options

| Option                | Env var                 |                                                                           |
| --------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `--policy <path>`     |                         | `flagguard.yml` location (auto-detected otherwise)                        |
| `--metrics <url>`     | `FLAGGUARD_METRICS_URL` | App exposing `/flagguard/metrics/:flag`; enables health gates and `watch` |
| `--offline <shopUrl>` | `FLAGGUARD_OFFLINE_URL` | Drive the demo shop instead of Flagsmith (no account needed)              |
| `--state-dir <dir>`   |                         | Where `state.json` and `audit.jsonl` live (default `.flagguard/`)         |
| `--json`              |                         | Machine-readable output                                                   |
| `--verbose`           |                         | Debug logs from the Flagsmith client                                      |

Flagsmith credentials come from `FLAGSMITH_API_KEY` and `FLAGSMITH_PROJECT_ID` (the nearest
`.env` is loaded automatically).

## Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| `0`  | Success, including "pending approval"    |
| `1`  | Error (API failure, unreachable service) |
| `2`  | Invalid configuration or usage           |
| `3`  | Blocked by a gate or denied by policy    |

Exit code `3` lets CI pipelines tell "not safe yet" apart from "broken".
