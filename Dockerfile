# syntax=docker/dockerfile:1
# One image runs both processes: the web app (default CMD) and the worker
# (override the command with: node dist/worker/index.js).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --chown=node:node package.json LICENSE THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health?soft=1 >/dev/null || exit 1
CMD ["node", "dist/server/index.js"]
