# Deploying CommentFlow on public HTTPS

CommentFlow is **two processes** sharing **two datastores**:

```
                Meta webhooks ─┐        ┌──> PostgreSQL (accounts, campaigns, logs)
 Browser ── HTTPS ── web app ──┼────────┤
                               └─ queue ┴──> Redis (BullMQ queue, rate limits)
                                             ▲
                          worker ────────────┘  (sends DMs, retries, refreshes tokens)
```

- **web** (`node dist/server/index.js`): dashboard, REST API, Meta webhook, OAuth
  callback, tracked-link redirects.
- **worker** (`node dist/worker/index.js`): consumes the queue and calls Instagram.
  **If the worker isn't running, nothing gets sent.** Serverless platforms can't
  host it; it needs an always-on process.

Both must share the same `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET` and
**`ENCRYPTION_KEY`** (the web app encrypts tokens and the worker decrypts them).
Both run migrations on boot; an advisory lock makes that safe.

## Option A: one VPS with Docker Compose + Caddy (recommended)

Any small Linux VPS (1 vCPU / 1–2 GB RAM) with a domain name works.

1. **[YOU]** Point a DNS **A record** (e.g. `dm.example.com`) at the server's IP.
2. **[YOU]** Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Copy the project to the server, e.g. `git clone <your fork> commentflow && cd commentflow`.
4. Create `.env`:
   ```bash
   cp .env.example .env
   sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
   sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
   ```
   Then edit `.env`:
   ```ini
   APP_URL=https://dm.example.com
   DOMAIN=dm.example.com
   NODE_ENV=production
   DEMO_MODE=false
   POSTGRES_PASSWORD=<another long random string>
   # Meta values from docs/META_SETUP.md:
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   FACEBOOK_APP_SECRET=...
   WEBHOOK_VERIFY_TOKEN=...
   ```
5. Start everything, with Caddy terminating HTTPS:
   ```bash
   docker compose --profile https up -d --build
   docker compose ps
   docker compose logs -f web worker
   ```
   Caddy obtains a Let's Encrypt certificate for `DOMAIN` automatically (ports
   80 and 443 must be open).
6. Open `https://dm.example.com`, create your account, then **set
   `ALLOW_REGISTRATION=false`** in `.env` and run `docker compose up -d` so
   strangers can't sign up. Invited teammates can still join.
7. Check `https://dm.example.com/api/health`: you want `"status":"ok"` and
   `"worker":{"healthy":true}`.

In this mode port 3000 is also published directly. To expose only Caddy, set
`WEB_PORT=127.0.0.1:3000` in `.env`.

**Backups:** `docker compose exec postgres pg_dump -U commentflow commentflow > backup.sql`.
Back up `.env` too: without `ENCRYPTION_KEY` the stored tokens can't be decrypted.

**Updating:** `git pull && docker compose --profile https up -d --build`. Migrations run automatically.

## Option B: Render / Railway / Fly.io

Create these four things in one project, all from the same repo and image:

| Service | Settings |
| --- | --- |
| PostgreSQL | Managed Postgres 14+ |
| Redis | Managed Redis that supports blocking commands (BullMQ needs them; HTTP-only Redis won't work). Set eviction policy to `noeviction`. |
| Web service | Docker (uses the `Dockerfile`), port 3000, health check path `/api/health` |
| Background worker | Same Docker image, start command `node dist/worker/index.js` |

Give **both** services the same environment variables (`.env.example` lists
them), with `APP_URL` set to the web service's public `https://` URL and
`TRUST_PROXY=1`. Use the platform's internal database/Redis URLs where available.

Without Docker: build command `npm ci && npm run build`, start commands
`npm start` (web) and `npm run start:worker` (worker).

## Option C: Node directly (no Docker)

```bash
npm ci && npm run build
NODE_ENV=production npm start           # web, behind nginx/Caddy for HTTPS
NODE_ENV=production npm run start:worker
```

Run both under systemd or pm2 so they restart on failure, and put a TLS
reverse proxy in front of the web process.

## After deploying

1. Configure the Meta app with your real URLs ([META_SETUP.md](META_SETUP.md)).
2. Connect your Instagram account.
3. Run a live test ([LIVE_TEST.md](LIVE_TEST.md)).

## Production checklist

- [ ] `APP_URL` is `https://` and is the primary domain (no redirects in front of `/api/webhook`)
- [ ] `DEMO_MODE=false`, `ALLOW_REGISTRATION=false` after your first account
- [ ] `SESSION_SECRET` and `ENCRYPTION_KEY` are random, identical on web and worker, and backed up
- [ ] The worker is running (`/api/health` → `worker.healthy: true`)
- [ ] Redis uses `noeviction` and persistence (AOF)
- [ ] Database backups are scheduled
