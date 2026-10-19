#!/usr/bin/env bash
# Verifies a built Pages artifact before it is published.
#   node scripts/build-pages-artifact.mjs --env all --out _site
#   bash scripts/verify-pages-artifact.sh _site
# Fails the pipeline rather than publishing a broken site (missing environment,
# wrong base path, or a bundle without its wasm kernel).
set -euo pipefail

DIR="${1:-_site}"
REPO_BASE="${PAGES_BASE:-/llm-infra-planner/}"

for env in "" "staging/" "dev/"; do
  page="$DIR/${env}index.html"
  [ -f "$page" ] || { echo "✗ missing $page"; exit 1; }
  # Placeholder declarado (branch ainda não criada — spec 13) é aceito explicitamente:
  # ele não tem bundle, então não há base path a conferir. O que NÃO se aceita é uma
  # página real apontando para o base path errado (deep links quebrariam).
  if grep -q 'name="llmcalc-placeholder"' "$page"; then
    echo "· ${env:-root} is a declared placeholder (its branch does not exist yet)"
  else
    grep -q "${REPO_BASE}${env}assets/" "$page" \
      || { echo "✗ base path mismatch in ${env:-root} (expected ${REPO_BASE}${env}assets/)"; exit 1; }
  fi
done

[ -f "$DIR/wasm/llmcalc-kernel.wasm" ] || { echo "✗ wasm kernel missing from the artifact"; exit 1; }
[ -f "$DIR/404.html" ] || { echo "✗ 404.html missing (SPA deep links would break)"; exit 1; }

# Pitch executivo: subcaminho próprio no mesmo artefato (nunca um site à parte).
[ -f "$DIR/executivo/index.html" ] || { echo "✗ executivo/index.html missing (pitch would not be published)"; exit 1; }
grep -q "Pitch empreendedor" "$DIR/executivo/index.html" || { echo "✗ executivo/index.html is not the pitch"; exit 1; }

# each environment must ship its own kernel (the bundle fetches <base>/wasm/…)
for env in "" "staging/" "dev/"; do
  [ -f "$DIR/${env}wasm/llmcalc-kernel.wasm" ] || { echo "✗ ${env:-root} has no wasm kernel"; exit 1; }
done

du -sh "$DIR" | sed 's/^/· size: /'
echo "✓ three environments + /executivo/, correct base paths, wasm kernel included in each"
