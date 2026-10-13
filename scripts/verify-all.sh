#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Bateria de verificação do LLMcalc — cada check DEVE retornar exit 0.
#
#   npm run verify:all            # bateria completa (inclui sync e auditoria)
#   npm run verify:all -- --quick # só o que não depende do estado consolidado
#
# O CI roda as mesmas verificações distribuídas em jobs (ci.yml, continuity-gate.yml);
# este script é o caminho de uma linha para reproduzir tudo localmente, e falha
# listando exatamente quais checks ficaram vermelhos (logs em .verify-fail/).
#
# Um check por linha, sem encurtar o resultado: gate que não roda não é gate.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MODE="full"
[ "${1:-}" = "--quick" ] && MODE="quick"

LOG_DIR=".verify-fail"
rm -rf "$LOG_DIR"

PASS=0
FAIL=0
FAILED=""

check() { # check <nome> <comando...>
  local name="$1"
  shift
  local out
  out="$(mktemp)"
  if "$@" >"$out" 2>&1; then
    printf '  ✅ %-18s %s\n' "$name" "$(tail -1 "$out" | tr -d '\r' | cut -c1-64)"
    PASS=$((PASS + 1))
  else
    printf '  ❌ %-18s %s\n' "$name" "$(grep -aiE 'error|erro|✗|failed|not found' "$out" | head -1 | cut -c1-76)"
    FAIL=$((FAIL + 1))
    FAILED="$FAILED $name"
    mkdir -p "$LOG_DIR"
    cp "$out" "$LOG_DIR/$name.log"
  fi
  rm -f "$out"
}

echo "═══ Bateria de verificação ($MODE) · $(date -u +%Y-%m-%dT%H:%M:%SZ) · $(git rev-parse --short HEAD 2>/dev/null || echo 'sem git') ═══"

# ── artefatos e dados ────────────────────────────────────────────────────────
check workflows        npm run --silent validate:workflows
check wasm:build       npm run --silent build:wasm
check wasm:verify      npm run --silent wasm:verify
check validate:data    npm run --silent validate

# ── código ───────────────────────────────────────────────────────────────────
check typecheck        ./node_modules/.bin/tsc -b --force
check tests            npm test
check lint             npm run --silent lint
check lint:changed     npm run --silent lint:changed
check build:app        npm run --silent build:app

# ── continuidade e ledger ────────────────────────────────────────────────────
check validate:access  npm run --silent validate:access
check validate:store   npm run --silent validate:store
check continuity:check npm run --silent continuity:check

# ── entregáveis de deploy ────────────────────────────────────────────────────
check deploy:docker    npm run --silent deploy:docker
check build:pages      node scripts/build-pages-artifact.mjs --env all --out _site
check pages:3-envs     test -f _site/index.html -a -f _site/staging/index.html -a -f _site/dev/index.html

# ── gates que dependem do estado consolidado ─────────────────────────────────
if [ "$MODE" = "full" ]; then
  check continuity:sync npm run --silent continuity:sync -- --pages
  check agent:status    npm run --silent agent -- status
  check agent:audit     npm run --silent agent -- audit
fi

echo "═══ RESULTADO: $PASS OK · $FAIL FALHA ═══"
if [ "$FAIL" -ne 0 ]; then
  echo "checks vermelhos:$FAILED"
  echo "logs: $LOG_DIR/"
  exit 1
fi
