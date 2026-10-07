# SPEC 14: Deploy with Docker / nginx

## Description

One Dockerfile builds **two images** from one source tree:

| Target | Image | Contents | Port |
|---|---|---|---|
| `runner` | `llmcalc:production` / `:staging` / `:dev` | static bundle (incl. `wasm/`) served by hardened nginx | 80 |
| `wasi` | `llmcalc:wasi` | Node + `scripts/wasi-server.mjs` + `wasi/dist/llmcalc-wasi.wasm` | 8787 |

`docker-compose.yaml` wires them together (plus staging/dev pages behind profiles), and nginx forwards `/api/*` to the WASI container so the browser only ever talks to its own origin.

## Requirements

### Requirement 1: Environment-parameterised page image
**User Story:** As an operator, I want one image definition that produces the production, staging and dev page, differing only by base path and env badge.

**Acceptance Criteria:**
- Build args: `APP_ENV` (`production|staging|dev`), `BASE_PATH` (`/`, `/staging/`, `/dev/`), `APP_VERSION`, `COMMIT`, optional `WASI_BASE_URL`; they are mapped to `VITE_*` so the bundle is built with the right base path and `/runtime` shows the correct env.
- `npm run build` inside the image runs `build:wasm` **first**, so the image always ships the were kernel and the WASI module (no stale artifacts).
- Runtime stage replacements: `nginx.conf` (hardened, full `nginx.conf`) + `dist/` → `/usr/share/nginx/html`; the entrypoint hook (`docker/entrypoint.d/10-wasi-upstream.sh`) rewrites the `/api` upstream from `WASI_UPSTREAM` and re-validates the config with `nginx -t`.
- Health and hardening: `HEALTHCHECK` on `/health`, `EXPOSE 80`, non-root nginx worker, `no-new-privileges`, dropped capabilities in compose, `wasi` service with a read-only rootfs + `tmpfs /tmp`.

### Requirement 2: WASI runtime image
**User Story:** As an operator, I want the compute service in a small, dependency-free image that can scale independently of the page.

**Acceptance Criteria:**
- The `wasi` stage copies only `scripts/wasi-server.mjs`, `scripts/wasi-run.mjs`, `scripts/lib/wasi-host.mjs`, `wasi/dist/` and `public/wasm/` — no `node_modules`, no dev dependencies.
- Runs as an unprivileged user, binds `0.0.0.0:8787`, responds on `/health` and `/api/*`, and exits cleanly on `SIGTERM` (graceful shutdown in `scripts/wasi-server.mjs`).
- No build step at container start: the `.wasm` is baked at image build time, so cold start is `node scripts/wasi-server.mjs` only.

### Requirement 3: Compose stack with profiles
**User Story:** As a developer, I want to bring up any combination of environments locally with a single command.

**Acceptance Criteria:**
- `docker compose up -d` → `app` (`:3000`, production) + `wasi` (`:8787`), `depends_on: condition: service_healthy`.
- `docker compose --profile staging up -d` adds `app-staging` (`:3001`), `--profile dev up -d` adds `app-dev` (`:3002`), `--profile all` brings up everything.
- All services: restart policy, healthchecks, log rotation (json-file, 10 MB × 3) and resource limits where sensible.
- Images are tagged `llmcalc:{production,staging,dev,wasi}` and the compose file is valid YAML on a machine with no docker installed (asserted by `npm run deploy:docker`).

### Requirement 4: nginx routing for the wasm era
**User Story:** As a user, I want the wasm module served with the right MIME type and the API proxied without CORS workarounds.

**Acceptance Criteria:**
- `location ^~ /wasm/` serves `.wasm` with `default_type application/wasm` and a 1-day cache (streaming compilation requires the correct type).
- `location ^~ /api/` proxies to `set $wasi_upstream "wasi:8787"` (overridable) with `resolver 127.0.0.11` (docker embedded DNS) so nginx resolves the service name **at request time** — the config passes `nginx -t` at image build even when no `wasi` host exists yet.
- Responses are cached briefly (`proxy_cache_path … wasi_cache`, `proxy_cache_valid 200 5s`, key = request URI) with `proxy_cache_lock` to absorb bursts of identical requests; upstream failures are not cached.
- `/health` stays available for orchestrators and the existing security headers / rate limits / SPA fallback are preserved (server-level headers + `try_files $uri $uri/ /index.html`).
- `SITE_BASE_PATH` is documented as build-time (`BASE_PATH`), not runtime, so sub-path deployments bake their base path.

### Requirement 5: Verification path
**User Story:** As a maintainer, I want the container stack verified both where docker exists and where it does not.

**Acceptance Criteria:**
- `npm run deploy:docker` performs **static validation** everywhere: compose services, wasi healthcheck, Dockerfile stages, `VITE_BASE_PATH` injection, `nginx -t` presence, `/api` + `/wasm` + `/health` locations, module artifacts present, entrypoint executable — and prints the exact docker commands when docker is unavailable.
- With docker present the same script builds the images (`--env <name>` for one), runs `docker compose config`, and with `--up` starts the stack and smoke-tests `/health` plus `/api/selftest` through nginx.
- `.github/workflows/docker.yml` builds both images with buildx, pushes to GHCR on `main`/tags (optional on manual dispatch) and runs an end-to-end smoke test on a **user-defined network** so nginx' resolver path is exercised:
  page `/health`, `Content-Type: application/wasm` for the kernel, `/api/selftest` and `/api/plan` through the proxy.

## Quick reference

```bash
# local
docker compose up -d                                  # page :3000 + wasi :8787
docker compose --profile staging --profile dev up -d  # + :3001 + :3002
curl -s localhost:3000/api/selftest                   # wasm executed via nginx

# build one environment
docker build --target runner --build-arg APP_ENV=staging --build-arg BASE_PATH=/staging/ -t llmcalc:staging .
docker build --target wasi -t llmcalc:wasi .
docker run --rm -p 8787:8787 llmcalc:wasi
docker run --rm -p 3000:80 --env WASI_UPSTREAM=host.docker.internal:8787 \
  --add-host host.docker.internal:host-gateway llmcalc:production

# registry
docker pull ghcr.io/camillanapoles/llm-infra-planner:latest
docker pull ghcr.io/camillanapoles/llm-infra-planner-wasi:latest
```

## Files

```
Dockerfile                         builder → runner (nginx) / wasi (node runtime)
docker/entrypoint.d/10-wasi-upstream.sh   WASI_UPSTREAM rewrite + nginx -t
nginx.conf                         /wasm MIME, /api proxy + cache, /health, SPA
docker-compose.yaml                app :3000 · app-staging :3001 · app-dev :3002 · wasi :8787
scripts/docker-build.mjs           static validation + docker build/compose/smoke
.github/workflows/docker.yml       buildx → GHCR + network smoke test
```
