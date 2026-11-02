# CommentFlow

Self-hosted Instagram DM automation. Someone comments a keyword on your post
(or DMs you, or replies to your Story), and CommentFlow sends them a
personalized DM with your link through **Meta's official Instagram API**. You
see every message, every skip with its reason, and every link click.

- **Comment-to-DM**: keyword on a post or reel, then Instagram's one-time private reply
- **DM and Story-reply triggers**: "Reply GUIDE to this Story" works
- **Optional public reply** under the comment, picked at random from your variations
- **Personalization** with `{username}`, plus up to two **tracked link buttons**
- **Analytics**: matches, sends, people reached, unique clicks, CTR, daily charts
- **Message log** with filters, search, delivery details and CSV export
- **Workspaces** with owner/admin/member roles and invite links
- **Safety built in**: webhook signature checks, duplicate-event prevention,
  retries with backoff, per-account hourly limits, encrypted tokens, and Meta's
  messaging rules (one private reply per comment, 7-day comment window,
  24-hour DM window) enforced in code
- **Demo mode** to try everything without any Meta credentials

It doesn't scrape, automate a browser, or ask for an Instagram password.

![Overview dashboard](docs/Screenshots/overview.png)

| Campaign editor with live preview | Campaign analytics |
| --- | --- |
| ![Campaign editor](docs/Screenshots/campaign-editor.png) | ![Campaign analytics](docs/Screenshots/campaign-analytics.png) |
| **Message log** | **Test simulator (demo mode)** |
| ![Message log](docs/Screenshots/message-log.png) | ![Test simulator](docs/Screenshots/test-simulator.png) |

*Screenshots from demo mode.*

> **Credits.** CommentFlow uses [OpenReply](https://github.com/diwenne/openreply)
> as its functional reference. OpenReply is built and maintained by **Diwen
> Huang**, and was originally forked from
> [instagram-comment-to-dm](https://github.com/im-anishraj/instagram-comment-to-dm)
> by **Anish Raj**. The keyword matcher is reused from OpenReply under the MIT
> license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Contents

1. [How it works](#how-it-works)
2. [Quick start: demo mode on your computer](#quick-start-demo-mode-on-your-computer)
3. [Try the demo](#try-the-demo)
4. [Run without Docker (for development)](#run-without-docker-for-development)
5. [Run the automated tests](#run-the-automated-tests)
6. [Going live with real Instagram](#going-live-with-real-instagram)
7. [How messages are delivered safely](#how-messages-are-delivered-safely)
8. [Configuration reference](#configuration-reference)
9. [Project layout](#project-layout)
10. [Limitations](#limitations)

---

## How it works

```
1. @maya comments "GUIDE" on your reel
2. Meta POSTs a signed webhook to  https://your-domain/api/webhook
3. Web app verifies the signature, stores the event (deduplicated), queues a job
4. Worker matches active campaigns, checks Meta's rules and your hourly limit,
   then sends the private reply (and optional public reply) via graph.instagram.com
5. The result lands in the message log; link taps go through /r/<slug> and are counted
```

| Part | Tech |
| --- | --- |
| Web app + API | Node.js 22, Express, TypeScript |
| Dashboard | React + Vite (served by the web app) |
| Database | PostgreSQL 14+ (plain SQL migrations in `migrations/`) |
| Queue | Redis + BullMQ |
| Worker | Separate Node process (`src/worker`) |

---

## Quick start: demo mode on your computer

**You need:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(or Docker Engine with Compose). Nothing else.

```bash
# 1. Get the code
git clone https://github.com/sahifasyed/commentflow.git
cd commentflow

# 2. Create your settings file
cp .env.example .env

# 3. Generate the two secrets (macOS/Linux; on Windows use Git Bash or WSL)
sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
sed -i.bak "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env

# 4. Start the web app, worker, PostgreSQL and Redis
docker compose up -d --build
```

Open <http://localhost:3000>. Check that everything is up at
<http://localhost:3000/api/health>; you want `"status":"ok"` and `"worker":{"healthy":true}`.

To stop: `docker compose down`. Your data persists in Docker volumes; to
erase it, use `docker compose down -v`.

## Try the demo

`.env.example` ships with `DEMO_MODE=true`. Demo accounts **never contact
Instagram**; what they would have sent goes to an outbox you can read.

1. **Create an account** on the sign-in page.
2. **Instagram accounts > Add demo account.**
3. **Campaigns > New campaign**: keyword `guide`, a message like
   `Hey {username}! Here's the guide`, a link such as `https://example.com`,
   and optionally a public reply. Watch the preview on the right update as you type.
4. **Test simulator**: send a comment `GUIDE please!` from `maya.makes`.
5. Open the **Message log** (Sent), the simulator's **Demo outbox** (the exact
   message and tracked link), and the campaign page (analytics).

The simulator also reproduces the hard cases:

| Try this | What you should see |
| --- | --- |
| Deliveries: *Twice* | Second delivery "ignored as a duplicate"; one DM only |
| Event age: `200` on a comment | Skipped: comment older than 7 days |
| Event: *Direct message*, age `30` | Skipped: outside 24-hour window |
| Response: *rate-limits the first try* | Queued, then Sent after an automatic retry (~30s) |
| Response: *rejects link buttons* | Sent, with the link inline instead of as a button |
| Response: *Connection drops* | Unconfirmed, never re-sent |
| Two campaigns with the same keyword | First sends the DM; second is skipped (one private reply per comment) |
| A comment with no keyword | Nothing logged |

## Run without Docker (for development)

**You need:** Node.js 20+ (22 recommended), PostgreSQL 14+, Redis 6+.

```bash
npm install
cp .env.example .env            # then set SESSION_SECRET and ENCRYPTION_KEY as above
# Point DATABASE_URL / REDIS_URL at your local services, e.g.
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/commentflow
createdb commentflow            # or: psql -c "create database commentflow"
npm run migrate
npm run dev                     # API :3000, dashboard :5173 (hot reload), worker
```

Open <http://localhost:5173> during development. For a production-style run:
`npm run build`, then `npm start` and `npm run start:worker` in two terminals,
and open <http://localhost:3000>.

## Run the automated tests

The tests use a real PostgreSQL and Redis (the test database is wiped on each run).

```bash
createdb commentflow_test       # once
npm test
```

Override the connections with `TEST_DATABASE_URL` and `TEST_REDIS_URL` (default
`postgresql://postgres:postgres@localhost:5432/commentflow_test` and
`redis://localhost:6379/15`). `npm run typecheck` checks the server and dashboard types.

The 64 tests cover: keyword matching, encryption, webhook signatures and
parsing (comments, DMs, Story replies, echoes, ads), the Graph API request
shapes, OAuth, auth, CSRF, roles and invites, campaign validation, the full
webhook-to-DM pipeline, duplicate prevention, Meta's windows and
one-reply-per-comment rule, retries, rate limiting, unconfirmed deliveries,
token failures, click tracking, analytics, CSV export, data deletion, and a
real BullMQ worker run. Instagram itself is simulated, so they **don't prove
live messaging**; see [docs/LIVE_TEST.md](docs/LIVE_TEST.md) for that.

## Going live with real Instagram

Do these in order. Steps marked **[YOU]** need your accounts or credentials;
**[META]** steps wait on Meta.

1. **Deploy on a public HTTPS URL.** [YOU] → [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
   (a VPS with `docker compose --profile https up -d` gives you automatic HTTPS via Caddy).
2. **Create and configure a Meta app.** [YOU] → [docs/META_SETUP.md](docs/META_SETUP.md):
   app credentials, redirect URI, webhook URL and fields, tester invite, privacy URLs.
3. **Publish the app (Live mode).** [YOU] / [META]
4. **Connect your Instagram account** from the Instagram accounts page. [YOU]
5. **Run a live test** with a second Instagram account. [YOU] → [docs/LIVE_TEST.md](docs/LIVE_TEST.md)
6. **Only for other people's accounts:** App Review for Advanced Access, plus Business
   Verification. [META] → see the end of META_SETUP.md

## How messages are delivered safely

| Concern | What CommentFlow does |
| --- | --- |
| Forged webhooks | `X-Hub-Signature-256` HMAC verified against the raw body with your app secret; failures return 401 and are logged |
| Meta redelivering events | Identical bodies are dropped (`webhook_deliveries.body_sha256`); the same comment/message id is stored once (`inbound_events` unique key); queue job id = event id |
| DB down during a webhook | Nothing is acknowledged until it's committed, so Meta retries; a sweeper re-queues anything the queue missed |
| Duplicate DMs | Each (campaign, event) has one log row; a send is claimed atomically (`pending → sending`) before calling Instagram; a DB unique index enforces one private reply per comment across campaigns |
| Ambiguous Instagram responses | Code 1/2, 5xx, timeouts and crashes mid-send become **Unconfirmed** and are never auto-resent |
| Throttling | Redis per-account hourly caps (default 750 private replies, 200 DMs, 200 public replies) reserved atomically; when full, jobs are delayed until the window resets. Meta rate-limit errors retry with exponential backoff (30s → 4 min), at most 3 send attempts |
| Meta's messaging rules | Private reply only within 7 days of the comment; DMs/Story replies only within 24h of the person's last message; text clamped to 1000 bytes, button text to 640, button titles to 20 chars, max 2 link buttons; own comments and echoes ignored; optional per-person cooldown |
| Token security | Instagram tokens encrypted with AES-256-GCM, never sent to the browser, wiped on disconnect, refreshed before their 60-day expiry; an invalid token marks the account "Reconnect needed" and stops sends |
| Accounts & sessions | scrypt password hashes, HttpOnly SameSite cookies, CSRF header on every write, login rate limiting, roles enforced server-side |
| Data deletion | Meta deauthorize and signed data-deletion callbacks implemented |

## Configuration reference

All settings are environment variables; see [`.env.example`](.env.example) for
the full commented list. The essentials:

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public URL (https in production). Used for OAuth, webhooks and tracked links |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | `openssl rand -hex 32` each; identical on web and worker; back them up |
| `DATABASE_URL`, `REDIS_URL` | PostgreSQL and Redis connections |
| `DEMO_MODE` | `true` enables demo accounts and the simulator. Use `false` in production |
| `ALLOW_REGISTRATION`, `ALLOWED_EMAILS` | Who can sign up |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` | Meta app credentials |
| `PRIVATE_REPLY_HOURLY_LIMIT`, `DM_HOURLY_LIMIT`, `PUBLIC_REPLY_HOURLY_LIMIT` | Per-account hourly caps |

Useful URLs: dashboard `/`, health `/api/health`, webhook `/api/webhook`, OAuth
callback `/api/instagram/callback`, tracked links `/r/<slug>`, legal pages
`/privacy`, `/terms`, `/data-deletion`.

## Project layout

```
src/
  config.ts              environment validation
  db/                    pg pool + migration runner
  lib/                   crypto, keyword matcher (from OpenReply), templates, rate limiter, Meta rules
  meta/                  webhook verify/parse, Graph API client, OAuth, demo provider, error classes
  services/              ingest (web), processor (worker), analytics, maintenance jobs
  server/                Express app, auth/RBAC, routes
  worker/                BullMQ workers: events, token refresh, sweeper, stale-claim expiry
migrations/              SQL schema
web/src/                 React dashboard
tests/                   unit + integration tests (vitest)
docs/                    META_SETUP, DEPLOYMENT, LIVE_TEST
```

## Limitations

- **Live messaging is unverified until you complete [LIVE_TEST.md](docs/LIVE_TEST.md)**
  with your own Meta app; Meta's dashboards and policies change, and some
  steps need your approval or Meta's.
- Not included from OpenReply: the opening-DM button flow, the follow gate,
  the inbox, Zernio as an alternative provider, the read-only API/MCP, and
  multi-language UI.
- Instagram Live comments are ignored (private replies there only work during the broadcast).
- Login is email + password. There is no email delivery, so invites are links you share yourself.
- The legal page texts are templates; review them before publishing your Meta app.

## About

Built by Sahifa Syed with AI assistance (Claude). I set the requirements, chose
OpenReply as the reference, and reviewed the design; the code was generated
and tested in collaboration with Claude.

## License

MIT © 2026 Sahifa Syed. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
