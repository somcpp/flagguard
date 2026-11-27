# FlagGuard demo shop

A tiny storefront whose **new one-page checkout** is gated by a Flagsmith flag
(`fg_new_checkout`). It's the "production app" FlagGuard rolls out and protects in the demo.

- **Legacy checkout:** the old, battle-tested path.
- **New checkout:** faster, with a 10% bundle discount. It's new code, so it gets rolled out gradually.

Every checkout is recorded against its **cohort**, `treatment` (flag on) or `control`
(flag off), and exposed at `GET /flagguard/metrics/:flag` for FlagGuard's watcher.

## Run it

From the repository root:

```bash
npm install
npm run build
npm run shop       # http://localhost:3000
npm run traffic    # in a second terminal: ~15 checkouts/s from 500 users
```

### With Flagsmith (real flag evaluation)

Add a **server-side** environment key (Environment → Settings → SDK Keys, starts with `ser.`)
to `.env` in the repository root:

```bash
FLAGSMITH_SERVER_KEY=ser.xxxxxxxx
```

The shop then uses the Flagsmith Node SDK in **local evaluation** mode. It refreshes the
environment document every `FLAG_REFRESH_SECONDS` (default 5s) and evaluates
FlagGuard's percentage-split segments in-process. If Flagsmith is unreachable,
every user gets the legacy checkout (fail safe).

### Offline (no account needed)

Without a server key the shop runs in offline mode with a local, consistent-hash
percentage rollout:

```bash
curl -X PUT localhost:3000/admin/offline-rollout -H 'Content-Type: application/json' -d '{"percentage":25}'
```

## Breaking things on purpose

The **Inject bug** button (or the API) makes the new checkout fail and slow down.
Only the new code path is affected, which is exactly what FlagGuard's cohort
comparison detects:

```bash
curl -X PUT localhost:3000/admin/chaos -H 'Content-Type: application/json' -d '{"errorRate":0.4,"extraLatencyMs":250}'
curl -X DELETE localhost:3000/admin/chaos
```

## API

| Method           | Path                       | Purpose                                                |
| ---------------- | -------------------------- | ------------------------------------------------------ |
| `POST`           | `/api/checkout`            | `{ userId, items: [{ productId, quantity }] }` → order |
| `GET`            | `/api/products`            | Catalogue                                              |
| `GET`            | `/api/status`              | Flag name, provider mode, chaos settings               |
| `GET`            | `/flagguard/metrics/:flag` | Per-cohort requests, error rate, p50/p95 latency       |
| `PUT` / `DELETE` | `/admin/chaos`             | Inject / clear failures in the new checkout            |
| `PUT`            | `/admin/offline-rollout`   | Set the rollout percentage (offline mode only)         |
| `DELETE`         | `/admin/metrics`           | Reset the metrics window                               |
| `GET`            | `/healthz`                 | Liveness                                               |

Set `SHOP_ADMIN_TOKEN` to require `Authorization: Bearer <token>` on `/admin/*`.

## Configuration

| Variable                  | Default           |                                         |
| ------------------------- | ----------------- | --------------------------------------- |
| `PORT`                    | `3000`            |                                         |
| `SHOP_FLAG_NAME`          | `fg_new_checkout` | Flag guarding the new checkout          |
| `FLAGSMITH_SERVER_KEY`    | none              | Server-side key; enables Flagsmith mode |
| `FLAGSMITH_SDK_API_URL`   | Flagsmith SaaS    | For self-hosted Flagsmith               |
| `FLAG_REFRESH_SECONDS`    | `5`               | Environment document refresh interval   |
| `OFFLINE_ROLLOUT_PERCENT` | `0`               | Initial offline rollout                 |
| `SHOP_ADMIN_TOKEN`        | none              | Protects `/admin/*`                     |
| `METRICS_WINDOW_SECONDS`  | `120`             | Sliding window for cohort metrics       |

## Traffic simulator

```bash
npm run traffic -- --rps 20 --users 500 --duration 60 --target http://localhost:3000
```

It uses a fixed pool of user identities so percentage splits are stable, and prints
error rates per checkout every 3 seconds.
