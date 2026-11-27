# Security Policy

FlagGuard holds a Flagsmith **Organisation API key**, which can change every flag in your
organisation. Treat it like a production credential:

- Store it in `.env` (git-ignored) locally, or in GitHub Actions **secrets** in CI.
- Never paste it into issues, PRs, logs or chat.
- Prefer a dedicated key for FlagGuard so it can be revoked independently.

FlagGuard never logs API keys. Request logs include method, path and status only.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/somcpp/flagguard/security/advisories/new)
and we will respond as soon as possible.
