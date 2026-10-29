# syntax=docker/dockerfile:1
#
# Trikey Guardian: one image for Umbrel and Start9.
# Build from the repository root:
#   docker build -f packaging/docker/Dockerfile -t trikey-guardian:local .
#
# No keys, state or credentials are baked in. Configuration comes from env
# (see packaging/README.md); /data is a volume for the encrypted key-3 state.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG VERSION=0.1.0

# ---- deps: full dependency tree, used to build the web UI -------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/guardian/package.json apps/guardian/
COPY apps/guardian-web/package.json apps/guardian-web/
RUN npm ci --no-audit --no-fund

# ---- build: compile the web UI into apps/guardian-web/dist -------------------
FROM deps AS build
COPY . .
RUN npm run build -w @trikey/guardian-web

# ---- prod: the lockfile's production dependency tree -------------------------
# The guardian runs TypeScript source through tsx (`node --import tsx`), and tsx is
# a root devDependency, so this production install leaves it out. The runtime stage
# copies tsx and its esbuild from the deps stage (same lockfile, same platform).
FROM ${NODE_IMAGE} AS prod
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/guardian/package.json apps/guardian/
COPY apps/guardian-web/package.json apps/guardian-web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG VERSION

LABEL org.opencontainers.image.title="Trikey Guardian" \
      org.opencontainers.image.description="Key 3 of a 2-of-3 bitcoin wallet: co-signs phone payments under a daily limit and runs Delay & Notify recovery, on your own home server" \
      org.opencontainers.image.source="https://github.com/TheIcarusWings/trikey" \
      org.opencontainers.image.url="https://github.com/TheIcarusWings/trikey" \
      org.opencontainers.image.documentation="https://github.com/TheIcarusWings/trikey/tree/main/packaging" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.vendor="Trikey contributors"

ENV NODE_ENV=production \
    PORT=3000 \
    TRIKEY_DATA_DIR=/data \
    TRIKEY_WEB_DIR=/app/apps/guardian-web/dist \
    BITCOIN_NETWORK=bitcoin

WORKDIR /app

# Production node_modules, then the workspace manifests and sources that the
# service imports at runtime. Only the built web UI is taken from the build stage.
COPY --from=prod /app/node_modules ./node_modules
# tsx and the esbuild it runs on, from the full install: both come from the
# lockfile, and @esbuild holds the binary for this platform.
COPY --from=deps /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=deps /app/node_modules/@esbuild ./node_modules/@esbuild
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/src ./packages/core/src
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/packages/protocol/src ./packages/protocol/src
COPY --from=build /app/apps/guardian/package.json ./apps/guardian/
COPY --from=build /app/apps/guardian/src ./apps/guardian/src
COPY --from=build /app/apps/guardian-web/dist ./apps/guardian-web/dist

# The node image already has a `node` user at uid/gid 1000. Code stays
# root-owned and read-only; only /data is writable.
RUN mkdir -p /data && chown 1000:1000 /data
VOLUME ["/data"]

EXPOSE 3000
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--import", "tsx", "apps/guardian/src/main.ts"]
