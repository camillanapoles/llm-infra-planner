# SPEC 13: Deploy to GitHub Pages (dev · staging · production)

## Description

One repository, one Pages site, **three live environments** published as sub-paths:

| Environment | Branch | Base path | URL |
|---|---|---|---|
| production | `main` | `/llm-infra-planner/` | https://camillanapoles.github.io/llm-infra-planner/ |
| staging | `staging` | `/llm-infra-planner/staging/` | https://camillanapoles.github.io/llm-infra-planner/staging/ |
| dev | `dev` | `/llm-infra-planner/dev/` | https://camillanapoles.github.io/llm-infra-planner/dev/ |

GitHub Pages serves a single site per repository, therefore all three bundles are assembled into **one artifact** (`_site/`) and deployed atomically. Every run rebuilds *all* environments — each from its own branch — which guarantees a dev-only deploy can never erase production.

The same mechanism doubles as a **no-push preview system**: `workflow_dispatch` accepts an arbitrary `ref`, so any branch (e.g. `arena/fe62ce6d-llm-infra-planner`) can be published to one environment while the others keep their branches.

## Requirements

### Requirement 1: Correct base path per environment
**User Story:** As a user, I want every environment to load its assets and wasm modules from its own sub-path without 404s.

**Acceptance Criteria:**
- The bundle is built with `VITE_BASE_PATH` (`/llm-infra-planner/`, `…/staging/`, `…/dev/`), which drives Vite `base`, `import.meta.env.BASE_URL` and therefore the kernel fetch URL (`wasm/llmcalc-kernel.wasm`).
- `scripts/build-pages-artifact.mjs --env all` produces:
  ```
  _site/index.html                 ← production
  _site/{assets,wasm}/…            ← production kernel + bundle
  _site/staging/{index.html,404.html,assets,wasm}
  _site/dev/{index.html,404.html,assets,wasm}
  ```
- Each environment gets `404.html` (copy of its `index.html`) so SPA deep links work on Pages, and `.nojekyll` so the `assets/` folder is published verbatim.
- CI verifies the layout and asserts the built HTML references the right prefix (`/llm-infra-planner/{staging,dev}/assets/…`) before uploading, so a wrong base path fails the pipeline instead of shipping a blank page.
- `VITE_APP_ENV` is baked into each bundle (`src/lib/env.ts`), the header shows an env chip, and `/runtime` lists the environment URLs.

### Requirement 2: Push-driven deployment per branch
**User Story:** As a maintainer, I want a push to `dev`, `staging` or `main` to refresh exactly that environment and nothing else.

**Acceptance Criteria:**
- `.github/workflows/deploy-pages.yml` triggers on `push` to `main`, `staging`, `dev` (markdown/`.kiro` changes ignored) and on `workflow_dispatch`.
- Jobs: `detect` (matrix + scope) → `build` (matrix over the three environments, `fail-fast: false`) → `assemble` (download all, verify layout, upload the single Pages artifact) → `deploy` (`actions/deploy-pages`, environment `github-pages`).
- A branch that does not exist yet produces a **placeholder page** for that environment (with instructions to run the bootstrap workflow) instead of failing the run.
- `assemble` refuses to publish when a required file is missing (`index.html`, `staging/index.html`, `dev/index.html`, `wasm/llmcalc-kernel.wasm`) — the previous deployment stays live.
- Concurrency is serialized (`group: pages`, `cancel-in-progress: false`) and the deploy job prints a summary table with all three URLs and the source refs used.
- Required permissions are minimal: `contents: read`, `pages: write`, `id-token: write`.

### Requirement 3: Publish any ref without pushing
**User Story:** As a developer (or an AI agent), I want to publish a feature branch to dev/staging for review without creating or pushing any branch.

**Acceptance Criteria:**
- `workflow_dispatch` inputs: `ref` (branch/tag/SHA, default empty = per-environment branches) and `environments` (`all|production|staging|dev`).
- Only the selected environment consumes `ref`; the others keep building their own branch, so production stays untouched:
  ```bash
  gh workflow run deploy-pages.yml -f ref=arena/fe62ce6d-llm-infra-planner -f environments=dev
  → dev = arena/…  ·  staging = staging  ·  production = main
  ```
- `-f environments=all` publishes the whole site from that ref (full-site preview of a branch).
- Workflow files must live on the default branch for dispatch to be available — this is exactly what `.github/workflows/bootstrap-repo.yml` (spec 16) ensures when it runs on `main`.

### Requirement 4: Pages enabled without manual clicking (where possible)
**User Story:** As a repo owner, I want the pipeline to turn Pages on by itself.

**Acceptance Criteria:**
- `actions/configure-pages@v5` runs with `enablement: true`, so the first deploy attempt enables Pages with the *GitHub Actions* source.
- The bootstrap workflow additionally tries `POST /repos/{owner}/{repo}/pages` (`build_type=workflow`) and degrades to an actionable warning (Settings → Pages → Source: GitHub Actions) when the token lacks admin rights.
- Documentation states the one manual fallback and the resulting URLs.

## Usage

```bash
# normal flow — push to a branch
git push origin dev          # → dev/ refreshes
git push origin staging      # → staging/ refreshes
git push origin main         # → production refreshes

# preview a branch without pushing it anywhere
gh workflow run deploy-pages.yml -f ref=my-feature -f environments=dev

# rebuild everything from current branches
gh workflow run deploy-pages.yml

# build/verify the artifact locally (no Pages involved)
npm run build:pages -- --env all --out _site
npm run serve:pages -- --port 4180     # http://localhost:4180/{,staging/,dev/}
```

## Files

```
scripts/build-pages-artifact.mjs   multi-environment artifact builder
scripts/serve-static.mjs           local stand-in for Pages/nginx (SPA 404, wasm MIME, /api proxy)
.github/workflows/deploy-pages.yml detect → build → assemble → deploy
.github/workflows/ci.yml           pages-artifact job (layout + base path assertions)
src/lib/env.ts                     VITE_APP_ENV / BASE_URL → env badge, runtime page
vite.config.ts                     base = VITE_BASE_PATH
```
