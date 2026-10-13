# SPEC 15: Local runtime & offline deployment

## Description

The whole system must run on a laptop (or in a cloud dev sandbox such as the Arena preview) with **no external services**: the page, the wasm kernel and the WASI runtime host all live in one working copy. This spec defines the local entry points, the environment model, and how a built artifact is verified the same way nginx/Pages would serve it.

## Requirements

### Requirement 1: One command starts everything
**User Story:** As a developer, I want a single command that gives me the page and the compute service, correctly wired.

**Acceptance Criteria:**
- `npm run stack` (`scripts/dev-stack.mjs`) starts both processes, prefixes their logs (`vite │`, `wasi │`) and shuts both down on `Ctrl-C`/`SIGTERM`.
  - page → `http://0.0.0.0:5173` (Vite, `PORT` overridable)
  - WASI runtime → `http://0.0.0.0:8787` (`WASI_PORT` overridable)
- Servers bind `0.0.0.0` (not `127.0.0.1`) so the browser preview proxy in hosted sandboxes can reach them.
- `vite.config.ts` proxies `/api/*` → `WASI_PROXY_TARGET` (default `http://127.0.0.1:8787`) and tolerates an unreachable host (logs a warning, returns 502) instead of crashing — so `npm run dev` alone still works without the runtime.
- Both dev and preview servers proxy `/api`, so the built page behaves identically under `vite preview` and in the container.

### Requirement 2: CLI access to the wasm module
**User Story:** As a developer, I want to run plan math from my terminal without starting any server.

**Acceptance Criteria:**
- `npm run wasi -- <command> [args]` runs `wasi/dist/llmcalc-wasi.wasm` under `node:wasi` and pretty-prints the JSON result; exit code mirrors the module (`0` ok, `64` unknown command, `1` when the module is missing).
- `npm run wasi` with no arguments prints a usage block with the module path, size, imports and exports.
- If the module is missing the CLI fails with the remediation (`npm run build:wasm`), never with a stack trace.
- `npm run build:wasm` needs no network and no native toolchain: AssemblyScript is a devDependency, so a fresh clone is `npm ci && npm run build:wasm`.

### Requirement 3: Verify a production build locally
**User Story:** As a developer, I want to serve the built artifact exactly like nginx/Pages would and check deep links and wasm MIME types.

**Acceptance Criteria:**
- `npm run build` produces `dist/` (bundle + `wasm/`); `npm run serve` serves it on `:4173`; `npm run serve:pages` serves the multi-environment `_site/` artifact.
- `scripts/serve-static.mjs` implements the hosting behaviours that matter:
  - SPA fallback for extension-less paths (200 + `index.html`, using that mount's `404.html` when the path had an extension);
  - mount detection, so `_site/staging/` and `_site/dev/` are served from the same process;
  - correct MIME types, notably `application/wasm` for `.wasm`, plus `cache-control: no-store` for HTML;
  - `/api/*` proxied to `WASI_PROXY_TARGET`, returning a JSON 502 with the `npm run wasi:serve` hint when the runtime is down.
- Binds `0.0.0.0` and honours `--port`/`PORT`, so it can back a hosted preview.

### Requirement 4: Explicit environment model
**User Story:** As a maintainer, I want it to be obvious which environment a running build represents.

**Acceptance Criteria:**
- `src/lib/env.ts` resolves `VITE_APP_ENV` (`local|dev|staging|production`, default `local`) and exposes `ENV` (label, `isDeployed`, `hasBackend`, accent), `BASE_PATH`, `BUILD_INFO` (version, commit, builtAt) and `ENV_URLS`.
- The header renders an engine chip (`WASM`/`JS`) plus an environment chip when `isDeployed`; `/runtime` shows build env, version, commit and base path.
- `.env.example` documents every variable, and `npm run clean` removes `dist`, `_site`, `wasi/dist` and `public/wasm` so a rebuild is reproducible.

## Local quick reference

```bash
npm ci                    # install
npm run stack             # page :5173 + wasi :8787   ← open /runtime
npm run dev               # page only (JS fallback until the wasm module exists)
npm run build:wasm        # compile both wasm targets
npm run wasi -- selftest  # run inside a WASI runtime, no server
npm run wasi:serve        # runtime host only (dashboard on /)
npm run build             # wasm + typecheck + bundle → dist/
npm run serve             # serve dist/ like nginx :4173
npm run build:pages       # dist for all three envs → _site/
npm run serve:pages       # serve _site/ (/, /staging/, /dev/) :4173
npm run wasm:verify       # wasm gate (also used by CI)
```

Behaviour with the runtime offline (static hosting, GitHub Pages): the page keeps working on the wasm kernel; `/runtime` shows "WASI host offline" with the exact commands to start one; nothing throws.

## Files

```
scripts/dev-stack.mjs      one-command local page + runtime
scripts/wasi-server.mjs    HTTP runtime host (dashboard, /api/*, /wasm/*)
scripts/wasi-run.mjs       CLI bridge
scripts/serve-static.mjs   nginx/Pages stand-in (SPA 404, wasm MIME, /api proxy)
src/lib/env.ts             environment model + ENV_URLS + BUILD_INFO
.env.example               documented build variables
vite.config.ts             base, host 0.0.0.0, /api proxy (dev + preview)
```
