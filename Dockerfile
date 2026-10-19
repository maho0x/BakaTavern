# syntax=docker/dockerfile:1.7
# BakaTavern: one static binary with the web app embedded, on an empty base image.
#
#   docker build -t bakatavern .
#   docker run -d -p 8800:8800 -v bakatavern:/data -e BT_PASSWORD=change-me bakatavern
#
# Listening outside the container requires a password (BT_PASSWORD, or `bakatavern passwd`).

FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/api-client/package.json packages/api-client/
COPY packages/th-bridge/package.json packages/th-bridge/
COPY packages/plugin-api/package.json packages/plugin-api/
RUN pnpm install --frozen-lockfile --filter "@bakatavern/web..."
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @bakatavern/web build

FROM rust:1.99-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
COPY --from=web /src/apps/web/dist apps/web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p bt-cli \
    && cp target/release/bakatavern /bakatavern \
    && mkdir -p /rootfs/data /rootfs/tmp

FROM scratch
COPY --from=server /bakatavern /bakatavern
# Owned by the runtime user, so a fresh named volume is writable; SQLite also needs a temp dir.
COPY --from=server --chown=1000:1000 /rootfs/ /
ENV BT_DATA_DIR=/data \
    BT_HOST=0.0.0.0 \
    BT_PORT=8800 \
    TMPDIR=/tmp
USER 1000:1000
VOLUME /data
EXPOSE 8800
ENTRYPOINT ["/bakatavern", "serve"]
