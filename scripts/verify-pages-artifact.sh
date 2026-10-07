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
  grep -q "${REPO_BASE}${env}assets/" "$page" \
    || { echo "✗ base path mismatch in ${env:-root} (expected ${REPO_BASE}${env}assets/)"; exit 1; }
done

[ -f "$DIR/wasm/llmcalc-kernel.wasm" ] || { echo "✗ wasm kernel missing from the artifact"; exit 1; }
[ -f "$DIR/404.html" ] || { echo "✗ 404.html missing (SPA deep links would break)"; exit 1; }

# each environment must ship its own kernel (the bundle fetches <base>/wasm/…)
for env in "" "staging/" "dev/"; do
  [ -f "$DIR/${env}wasm/llmcalc-kernel.wasm" ] || { echo "✗ ${env:-root} has no wasm kernel"; exit 1; }
done

du -sh "$DIR" | sed 's/^/· size: /'
echo "✓ three environments, correct base paths, wasm kernel included in each"
