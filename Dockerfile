# syntax=docker/dockerfile:1

# --- base: Node 22 + the pnpm version from package.json ---------------------------------------
FROM node:22-slim AS base
RUN npm install --global --no-fund --no-audit pnpm@11.16.0
WORKDIR /app

# --- build: full install, bundle apps/server/src into apps/server/dist and the UI into
#     apps/web/dist (static files; no network is needed at runtime) ------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
# --ignore-scripts: the only allowed build script is lefthook (git hooks, useless here).
# onnxruntime-node needs no install script: its npm package ships the Linux x64/arm64 binaries
# (the postinstall only fetches optional CUDA files).
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json vite.config.ts ./
COPY packages/contracts packages/contracts
COPY apps/server apps/server
RUN pnpm build
COPY apps/web apps/web
RUN pnpm build:web

# --- deps: production dependencies only (fresh install, so devDependencies never get in) -----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# --- model: Xenova/multilingual-e5-small (q8), pinned revision, checked by SHA-256 -----------
FROM node:22-slim AS model
COPY scripts/download-model.mjs /tmp/download-model.mjs
RUN node /tmp/download-model.mjs /app/models

# --- runtime ----------------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    MODEL_DIR=/app/models \
    HF_HUB_OFFLINE=1
WORKDIR /app/apps/server
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=model /app/models /app/models
COPY apps/server/package.json ./
COPY apps/server/migrations ./migrations
COPY --from=build /app/apps/server/dist ./dist
# dist/main.js serves the UI from ../../web/dist, i.e. /app/apps/web/dist.
COPY --from=build /app/apps/web/dist /app/apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/healthz').then(r=>r.text()).then(t=>process.exit(t==='ok'?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
