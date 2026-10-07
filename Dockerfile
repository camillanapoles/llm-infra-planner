# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Builds the wasm kernel + WASI module + the vite bundle for one environment.
#   docker build --target runner --build-arg APP_ENV=staging --build-arg BASE_PATH=/ .
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (layer-cached separately from source)
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile

# Build-time environment (drives base path + env badge; see src/lib/env.ts)
ARG APP_ENV=production
ARG BASE_PATH=/
ARG APP_VERSION=0.0.0
ARG COMMIT=unknown
ARG WASI_BASE_URL=
ENV VITE_APP_ENV=$APP_ENV \
    VITE_BASE_PATH=$BASE_PATH \
    VITE_APP_VERSION=$APP_VERSION \
    VITE_COMMIT=$COMMIT \
    VITE_WASI_BASE_URL=$WASI_BASE_URL \
    NODE_OPTIONS=--max-old-space-size=2048

# Copy source and build (npm run build = build:wasm + tsc -b + vite build)
COPY . .
RUN npm run build \
    && echo "── artifacts ──" \
    && ls -la dist/wasm/ \
    && du -sh dist

# ── Stage 2: Static page on nginx ─────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

ARG APP_ENV=production
LABEL org.opencontainers.image.title="LLMcalc" \
      org.opencontainers.image.description="LLM infrastructure calculator — static page + WASI kernel (${APP_ENV})"

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf /etc/nginx/nginx.conf

# Copy hardened nginx config (full nginx.conf, not just server block)
COPY nginx.conf /etc/nginx/nginx.conf

# Copy built SPA assets (includes /wasm/*.wasm)
COPY --from=builder /app/dist /usr/share/nginx/html

# Container entrypoint hook: rewrites the /api upstream from $WASI_UPSTREAM
COPY docker/entrypoint.d/ /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/*.sh

# Drop privileges — run nginx worker as non-root
RUN chown -R nginx:nginx /usr/share/nginx/html \
    && chown -R nginx:nginx /var/log/nginx \
    && mkdir -p /var/cache/nginx/client_temp \
                /var/cache/nginx/proxy_temp \
                /var/cache/nginx/fastcgi_temp \
                /var/cache/nginx/uwsgi_temp \
                /var/cache/nginx/scgi_temp \
                /var/cache/nginx/wasi \
    && chown -R nginx:nginx /var/cache/nginx \
    && touch /var/run/nginx.pid /run/nginx.pid \
    && chown nginx:nginx /var/run/nginx.pid /run/nginx.pid

# Validate nginx config at build time
RUN nginx -t

ENV WASI_UPSTREAM=wasi:8787

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:80/health || exit 1

CMD ["nginx", "-g", "daemon off;"]

# ── Stage 3: WASI runtime host ────────────────────────────────────────────────
# Tiny image that executes web requests inside wasi/dist/llmcalc-wasi.wasm using
# node's built-in preview1 host. No dependencies, no build step at runtime.
FROM node:20-alpine AS wasi

WORKDIR /app
ENV NODE_ENV=production \
    WASI_HOST=0.0.0.0 \
    WASI_PORT=8787

# Only the runtime host + the two wasm modules are needed
COPY scripts/wasi-server.mjs scripts/wasi-run.mjs ./scripts/
COPY scripts/lib/wasi-host.mjs ./scripts/lib/
COPY --from=builder /app/wasi/dist ./wasi/dist
COPY --from=builder /app/public/wasm ./public/wasm

RUN addgroup -S llmcalc && adduser -S llmcalc -G llmcalc \
    && chown -R llmcalc:llmcalc /app
USER llmcalc

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "scripts/wasi-server.mjs"]
