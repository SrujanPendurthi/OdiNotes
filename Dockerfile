# syntax=docker/dockerfile:1
###############################################################################
# OdiNotes container builds.
#
# OdiNotes is a Tauri *desktop* app, so a container can't run the GUI as the
# product — its job here is to be a reproducible build/dev environment that
# bundles every dependency (Rust, Node, and Tauri's Linux system libs).
#
# Targets:
#   dev    — Node only. Vite dev server (:1420) + `npm run build` type-checks.
#            Native APIs are absent here: invoke()/the Rust backend don't run,
#            so this is for frontend/CI work, not exercising the real app.
#   bundle — Full Rust + Node + Tauri Linux system libs. Runs `tauri build`
#            and produces .deb/.AppImage. Linux only: a macOS .app/.dmg cannot
#            be built in a container (Apple SDK isn't licensed for Linux).
#
# Usage:
#   # Build the Linux bundles into ./artifacts on the host:
#   DOCKER_BUILDKIT=1 docker build --target export -o ./artifacts .
#
#   # Frontend dev server / type-check (see docker-compose.yml):
#   docker compose up dev
#   docker compose run --rm typecheck
###############################################################################

# ---- Shared Node deps layer (re-cached only when package*.json changes) -----
FROM node:22-bookworm AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- dev / type-check target (Node only, no native toolchain) ---------------
FROM node:22-bookworm AS dev
WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY . .
# Bind to 0.0.0.0 so the server is reachable from the host (vite.config.ts only
# enables an external host when TAURI_DEV_HOST is set).
ENV TAURI_DEV_HOST=0.0.0.0
EXPOSE 1420 1421
CMD ["npm", "run", "dev"]

# ---- Tauri Linux build environment ------------------------------------------
FROM node:22-bookworm AS bundle
# Tauri v2 Linux system dependencies (Debian bookworm package names).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libssl-dev \
      libxdo-dev \
      build-essential \
      curl wget file ca-certificates patchelf \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain, pinned to the crate's MSRV (src-tauri/Cargo.toml rust-version).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain 1.77.2 --profile minimal

# AppImage's bundler runs linuxdeploy AppImages; without FUSE in a container
# they must self-extract instead of mounting.
ENV APPIMAGE_EXTRACT_AND_RUN=1

WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY . .
# `tauri build` runs the frontend build first (beforeBuildCommand) then the
# native bundlers. Cache cargo downloads and the target dir across builds; copy
# the finished bundles to /artifacts (a real layer — cache mounts aren't kept).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/src-tauri/target \
    npm run tauri build \
    && mkdir -p /artifacts \
    && cp -r src-tauri/target/release/bundle/. /artifacts/

# ---- Export stage: `docker build --target export -o <dir>` drops bundles out -
FROM scratch AS export
COPY --from=bundle /artifacts/ /
