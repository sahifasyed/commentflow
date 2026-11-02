import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config.js";
import { loadUser, requireCsrfHeader } from "./auth.js";
import { HttpError, errorHandler } from "./http.js";
import { accountsRouter } from "./routes/accounts.js";
import { authRouter } from "./routes/auth.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { demoRouter } from "./routes/demo.js";
import { logsRouter } from "./routes/logs.js";
import { publicRouter } from "./routes/public.js";
import { webhookRouter } from "./routes/webhook.js";
import { workspacesRouter } from "./routes/workspaces.js";

function webDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, "../../web/dist"), resolve(process.cwd(), "web/dist")]) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
}

export function createApp() {
  const cfg = getConfig();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: cfg.APP_URL.startsWith("https://") ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // Webhook first: it needs the raw body, before any JSON parser runs.
  app.use("/api", webhookRouter);
  app.use(publicRouter); // /r/:slug, /api/health, /api/meta/*

  app.use(cookieParser());
  app.use(express.json({ limit: "200kb" }));
  app.use(loadUser);
  app.use("/api", requireCsrfHeader);
  app.use("/api", authRouter, workspacesRouter, accountsRouter, campaignsRouter, logsRouter, demoRouter);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));

  const dist = webDist();
  if (dist) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.type("text/plain").send("CommentFlow API is running. Build the dashboard with `npm run build:web`, or use `npm run dev`.")
    );
  }

  app.use(errorHandler);
  return app;
}
