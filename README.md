<div align="center">

# 🛡️ FlagGuard

**An AI agent that takes risky code from pull request to safe production, using [Flagsmith](https://flagsmith.com) feature flags.**

It acts on its own when that makes things _safer_, and asks a human whenever it would put more users at risk.

[![CI](https://github.com/somcpp/flagguard/actions/workflows/ci.yml/badge.svg)](https://github.com/somcpp/flagguard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

</div>

---

## The problem

Feature flags are the safest way to ship risky changes, but only if someone does the chores:
spot the risky change, create the flag in every environment, wrap the code, ramp the rollout,
watch the metrics, kill it at 2 a.m. when errors spike, and finally delete the flag.

Teams skip steps. Risky code ships unflagged, rollouts jump from 0% to 100%, and stale
flags pile up.

## What FlagGuard does

| Stage          | What happens                                                                                                                                                      | Who decides                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **1. Guard**   | Reads every PR diff, scores risk (payments, auth, migrations…), creates a flag in Flagsmith (on in dev, off in prod) and suggests a patch that wraps the new code | 🤖 Agent                        |
| **2. Rollout** | Ramps production exposure 5% → 25% → 50% → 100% using Flagsmith percentage-split segments                                                                         | 🧑 **Human approves each step** |
| **3. Watch**   | Compares error rate and latency of users on the new code vs the old code. On a regression it **kills the flag immediately** and posts an incident report          | 🤖 Agent                        |
| **4. Cleanup** | Once a flag is at 100% and healthy, opens a PR removing it and archives it in Flagsmith                                                                           | 🤖 opens PR · 🧑 merges         |

### The autonomy principle

> **The agent may act alone only when an action reduces risk.**
> Creating a disabled flag or killing a misbehaving one is always safe, so it's automatic.
> Anything that exposes more real users to new code needs a human.

This isn't just a convention. It's enforced in the policy schema: configuring
`advance_rollout: auto` is a **validation error** unless you explicitly set
`autonomy.allowUnsafe: true`, and the kill switch can never be disabled.

## How it uses Flagsmith

- **Features** are created idempotently via the Admin API, disabled by default.
- **Environments** each get their own state: on in Development, gated in Production.
- **Feature-specific segments** with `PERCENTAGE_SPLIT` rules drive gradual rollouts.
  Flagsmith hashes identities consistently, so users who had the feature at 5% keep it at 25%.
- **Segment overrides** are updated read-modify-write, so your team's own overrides
  (such as "internal users") are never clobbered.
- The **unified flag-state API** (`/api/__future__/…/features/{id}/`) works with and without
  v2 feature versioning.

## Status

FlagGuard is being built in phases during the
[Flagsmith hackathon](https://www.wemakedevs.org/hackathons/flagsmith) (Track 02: AI Agents & Feature Flags).

- [x] **Phase 1: Core.** Policy schema, autonomy engine, typed Flagsmith client, rollout primitives, kill switch
- [x] **Phase 2: Demo app.** A shop app wired to Flagsmith (local evaluation), a traffic simulator, per-cohort health metrics and chaos injection
- [x] **Phase 3: Rollout engine.** Staged rollouts with approval gates, cohort-based health guardrails, automatic kill switch, audit log, `flagguard` CLI
- [x] **Phase 4: Guard.** PR risk analysis (rules + AI), inline code suggestions that wrap the change, GitHub Action, `/flagguard` PR commands
- [ ] **Phase 5: Dashboard.** Timeline, approvals and live health
- [ ] **Phase 6: Cleanup.** Stale-flag removal PRs

## Repository layout

```
packages/
  core/        @flagguard/core: policy, autonomy, Flagsmith client, rollout engine, guardrails, audit log
  cli/         @flagguard/cli: the `flagguard` command
examples/
  shop/        demo storefront + traffic simulator (the app FlagGuard protects)
docs/
  architecture.md
flagguard.example.yml   annotated policy file
```

## Getting started (development)

```bash
git clone https://github.com/somcpp/flagguard.git
cd flagguard
npm install
npm run check        # format, lint, typecheck, test
```

Copy `.env.example` to `.env` and fill in your Flagsmith **Organisation API key**
(Organisation Settings → API Keys) and project ID. An LLM key is optional; without one
FlagGuard uses rule-based risk detection.

## Try the demo shop

```bash
npm run build
npm run shop      # http://localhost:3000
npm run traffic   # second terminal: steady checkout traffic
```

Works offline out of the box. Add `FLAGSMITH_SERVER_KEY` to `.env` to evaluate the flag with
Flagsmith. Click **Inject bug into new checkout** and watch the new-checkout cohort's error
rate climb while the legacy cohort stays healthy. See [examples/shop](examples/shop).

## Watch the agent save production (2 minutes, no account needed)

Three terminals from the repository root, after `npm install && npm run build`:

```bash
# 1. the app being protected
npm run shop
# 2. real traffic
npm run traffic
# 3. the agent
alias fg='npm run -s flagguard -- --offline http://localhost:3000 --policy examples/shop/flagguard.yml'
fg propose fg_new_checkout        # 🤖 "Start rollout at 5%?"  → pending approval
fg approve fg_new_checkout        # 🧑 you approve
fg advance fg_new_checkout --force  # 🧑 25%
fg watch fg_new_checkout          # 🤖 watching cohort health every 5s
```

Now click **Inject bug into new checkout** at http://localhost:3000. Within one check:

```
25%  UNHEALTHY  new: 41 req, 36.6% err, p95 315ms  │  old: 122 req, 0.0% err, p95 108ms
 🛑 KILL SWITCH PULLED: fg_new_checkout is OFF in Production
   36.6% errors on new code vs 0.0% on old code (max 2x); p95 315ms on new code vs 108ms on old code (max 1.5x)
```

`fg audit fg_new_checkout` shows the full story: who proposed, who approved, and why the agent
killed it. Drop `--offline` and the exact same commands drive Flagsmith via the Admin API.
See the [CLI reference](packages/cli).

## Configuration

Drop a `flagguard.yml` in your repository root (or `.github/`). Every field is optional
except `version`. See [`flagguard.example.yml`](flagguard.example.yml) for all options.

```yaml
version: 1
rollout:
  stages: [5, 25, 50, 100]
  minStageMinutes: 10
guardrails:
  maxErrorRate: 0.05 # absolute ceiling for users on the new code
  maxErrorRateRatio: 2 # kill if 2x worse than users on the old code
autonomy:
  actions:
    advance_rollout: approval # "auto" is rejected unless allowUnsafe: true
    kill_flag: auto
```

## Use it on your pull requests (GitHub Action)

```yaml
# .github/workflows/flagguard.yml
name: FlagGuard
on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  guard:
    if: github.event_name == 'pull_request' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/flagguard'))
    runs-on: ubuntu-latest
    steps:
      - uses: somcpp/flagguard@main
        with:
          flagsmith-api-key: ${{ secrets.FLAGSMITH_API_KEY }} # Organisation API key
          flagsmith-project-id: ${{ secrets.FLAGSMITH_PROJECT_ID }}
          llm-api-key: ${{ secrets.LLM_API_KEY }} # optional: Gemini or any OpenAI-compatible API
```

On every pull request FlagGuard:

1. **Scores risk** with your `flagguard.yml` rules (deterministic, explainable), then asks the AI
   for a second opinion. **The AI can raise the score but never lower it**, and if the AI is
   unavailable the review falls back to rules.
2. **Creates the flag** in Flagsmith when the change is risky: on in non-production, off in production.
3. **Posts one living report** (updated on every push), plus **one-click code suggestions** that
   wrap the new code in the flag. Suggestions are only posted on lines the PR added.
4. **Takes commands** from owners, members and collaborators:
   `/flagguard status`, `/flagguard approve` (next stage, health-checked), `/flagguard reject`,
   `/flagguard kill`.

Without Flagsmith secrets (for example on PRs from forks) it reviews and comments, but changes nothing.
Run the same review locally with `flagguard guard --base main`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
