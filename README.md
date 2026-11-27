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
- [ ] **Phase 3: Rollout engine.** Staged rollouts, health guardrails, audit log, CLI
- [ ] **Phase 4: Guard.** PR risk analysis (rules + LLM), code wrapping, GitHub Action, `/flagguard approve`
- [ ] **Phase 5: Dashboard.** Timeline, approvals and live health
- [ ] **Phase 6: Cleanup.** Stale-flag removal PRs

## Repository layout

```
packages/
  core/        @flagguard/core: policy, autonomy rules, Flagsmith client, rollout primitives, metrics
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
