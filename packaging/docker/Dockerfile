# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
#
# Trikey Guardian: one image for Umbrel and Start9.
#
# Build from the repository root. A reproducible build (see packaging/VERIFY.md) passes
# the commit time as SOURCE_DATE_EPOCH and exports with rewrite-timestamp=true:
#
#   docker buildx build -f packaging/docker/Dockerfile \
#     --build-arg SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" \
#     --build-arg VERSION=0.1.0 \
#     --output type=oci,dest=guardian.tar,rewrite-timestamp=true .
#
# A plain `docker build -f packaging/docker/Dockerfile -t trikey-guardian:local .` also
# works for local use; its layers just carry the build machine's file times.
#
# No keys, state or credentials are baked in. Configuration comes from env
# (see packaging/README.md); /data is a volume for the encrypted key-3 state.
#
# Why the build is reproducible (the same commit gives the same image digest):
#   - The Dockerfile frontend (the syntax line above) and the base image are pinned by
#     digest, so nothing moves under the build. To update either, change the digest in
#     a commit of its own and say which release it is.
#   - Dependencies come from `npm ci` against package-lock.json, which holds the
#     integrity hash of every package. Install scripts are skipped (--ignore-scripts),
#     so nothing runs at install time that could write a time or a path.
#   - There is no apt-get and no network fetch other than the npm registry, whose
#     answers are checked against the lockfile's hashes.
#   - The web UI is built by `vite build`, which names files by content hash and embeds
#     no build time, host name or absolute path (checked in packaging/VERIFY.md).
#   - File times and the image's `created` field come from SOURCE_DATE_EPOCH, which
#     BuildKit applies with --build-arg SOURCE_DATE_EPOCH and rewrite-timestamp=true.
#   - Nothing in the image records when or where it was built. The OCI labels below are
#     fixed text plus the version, and the CI does not add `org.opencontainers.image.created`.

# Node 22 on Debian bookworm, linux/amd64 and linux/arm64 in one manifest list.
# This is Node 22.23.4 as of 2026-10-28 (`docker buildx imagetools inspect node:22-bookworm-slim`).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG VERSION=0.1.0

# ---- manifests: the workspace manifests and the lockfile ---------------------
# Only what `npm ci` reads, so the install layers do not depend on source files. The
# lockfile also lists the workspaces left out here (packages/wallet, packages/recovery-key,
# apps/mobile); npm ci installs the ones present and skips the rest.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/silent-payments/package.json packages/silent-payments/
COPY apps/guardian/package.json apps/guardian/
COPY apps/guardian-web/package.json apps/guardian-web/

# ---- deps: full dependency tree, used to build the web UI -------------------
FROM manifests AS deps
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---- build: compile the web UI into apps/guardian-web/dist -------------------
FROM deps AS build
COPY . .
RUN npm run build -w @trikey/guardian-web

# ---- prod: the lockfile's production dependency tree -------------------------
# The guardian runs TypeScript source through tsx (`node --import tsx`), and tsx is
# a root devDependency, so this production install leaves it out. The runtime stage
# copies tsx and its esbuild from the deps stage (same lockfile, same platform).
FROM manifests AS prod
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
COPY --from=build /app/packages/silent-payments/package.json ./packages/silent-payments/
COPY --from=build /app/packages/silent-payments/src ./packages/silent-payments/src
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
