#!/bin/sh
# ── LLMcalc container entrypoint hook ────────────────────────────────────────
# Runs automatically by the official nginx image entrypoint (all executable
# scripts in /docker-entrypoint.d are sourced before nginx starts).
#
# Points nginx' /api/* proxy at the WASI runtime host:
#   WASI_UPSTREAM=wasi:8787        (default) → docker compose service
#   WASI_UPSTREAM=127.0.0.1:8787            → single container running both
#   WASI_UPSTREAM=                → leave the baked default untouched
set -e

if [ -n "${WASI_UPSTREAM}" ]; then
  sed -i "s|set \$wasi_upstream \"wasi:8787\"|set \$wasi_upstream \"${WASI_UPSTREAM}\"|" /etc/nginx/nginx.conf
  echo "[llmcalc] /api/* → ${WASI_UPSTREAM}"
fi

# Optional: serve the site from a sub-path (e.g. /staging) via a rewrite prefix
if [ -n "${SITE_BASE_PATH}" ] && [ "${SITE_BASE_PATH}" != "/" ]; then
  echo "[llmcalc] SITE_BASE_PATH=${SITE_BASE_PATH} (bake it at build time instead: --build-arg BASE_PATH)"
fi

nginx -t
