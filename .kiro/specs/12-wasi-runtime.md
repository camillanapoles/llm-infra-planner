# SPEC 12: WASI Runtime (kernel as a portable WebAssembly service)

## Description

The same calculation kernel is compiled a second time — as a **WASI preview1 command module** (`wasm/service.ts` → `wasi/dist/llmcalc-wasi.wasm`, ~5.6 KB) — so plan math can run *outside* the browser: on a laptop, in a container, in CI, or on a serverless WebAssembly host (Fermyon Spin, wasmCloud, wasmtime, WasmEdge, Wasmer).

Two execution surfaces:

1. **CLI** — `npm run wasi -- plan 16 0.54 0.5 1500 2.49` (via `scripts/wasi-run.mjs` → `node:wasi`).
2. **HTTP** — `npm run wasi:serve` exposes the module at `http://0.0.0.0:8787`; the page talks to it through `/<api>/…` (proxied by Vite in dev, nginx in Docker) and **never** to `localhost` from the browser.

## Requirements

### Requirement 1: Portable WASI command module
**User Story:** As a platform engineer, I want a single `.wasm` file I can run on any WASI runtime without installing anything else.

**Acceptance Criteria:**
- Imports are **confined to `wasi_snapshot_preview1`** (`args_sizes_get`, `args_get`, `fd_write`, `proc_exit`) — no `env.*` imports, no JS host functions.
- The module is a WASI *command*: it exports `_start` (and `memory`), writes JSON to stdout (`fd 1`) and exits `0` on success, `64` on an unknown command.
- Zero-runtime design: no allocator, no GC, no strings — static `memory.data` blocks plus a hand-rolled ASCII `f64` parser/formatter keep the module deterministic and tiny (< 64 KB budget, ~5.6 KB actual).
- Commands: `plan`, `kv`, `roofline`, `gpus`, `latency`, `selftest`, `info`; arguments are positional decimals (scientific notation, e.g. `8e9`, accepted).
- Output JSON always carries `ok`, `engine: "wasm-wasi"`, `runtime: "wasi-preview1"` and the command name; numbers use fixed notation with stable decimals (`16.0`, `0.50`).
- `selftest` returns the canonical vectors (`16`, `0.54`, `177`, `133`, `1`) so any host can be validated in one call.
- Portability is documented and tested on one host; the same file is addressable by others:
  `wasmtime run wasi/dist/llmcalc-wasi.wasm -- plan 16 0.54 0.5 1500 2.49`

### Requirement 2: Local runtime host with an HTTP API
**User Story:** As a developer, I want a zero-dependency service that executes requests inside the wasm module, so the browser can use the WASI engine locally.

**Acceptance Criteria:**
- `scripts/lib/wasi-host.mjs` is the host adapter: it instantiates the module with `node:wasi` (preview1), **starts it with `wasi.start(instance)`** (command modules must not be `initialize()`d) and captures stdout through a temporary fd, because WASI writes to a real file descriptor.
- `scripts/wasi-server.mjs` exposes:
  - `GET /health` and `GET /api/health` — runtime, module size, imports/exports, uptime (503 when the module is missing);
  - `GET /api/{plan,kv,roofline,gpus,latency,selftest,info}?…` and `POST /api/{command}` with a JSON body;
  - `POST /api/compute` — `{ command, args: [...] }` escape hatch;
  - `GET /` — a small status dashboard that runs the module server-side;
  - `GET /wasm/*.wasm` — the built modules with `application/wasm`.
- Responses are JSON with CORS headers; unknown commands return `{ ok: false, error }` and never crash the process.
- Binds to `0.0.0.0` (`WASI_HOST`/`WASI_PORT`) so container and preview proxies can reach it; graceful `SIGTERM`/`SIGINT` shutdown.

### Requirement 3: Browser integration without localhost
**User Story:** As a user, I want the page to use the WASI engine when it is available and to degrade cleanly when it is not.

**Acceptance Criteria:**
- `src/wasm/wasi-client.ts` uses **relative** URLs (`/api/*`) with a 2.5–4 s timeout and an `AbortController`; `VITE_WASI_BASE_URL` can point to another origin, but the default is same-origin.
- `useWasiRuntime()` polls health every 30 s and exposes `{ health, loading, refresh }`.
- On static hosting (GitHub Pages) the probe failure is an expected state: the Runtime page shows "static hosting" plus the exact commands to start a host locally.
- The **Runtime** page can execute a plan inside the WASI module (`POST /api/plan` → wasm) and prints the raw JSON response.
- Vite (`server.proxy`, `preview.proxy`) forwards `/api/*` to `WASI_PROXY_TARGET` (default `http://127.0.0.1:8787`); nginx does the same in the container (spec 14).

### Requirement 4: Verified in CI
**User Story:** As a maintainer, I want the wasm service proven to work before it ships.

**Acceptance Criteria:**
- `.github/workflows/ci.yml` job `wasi-runtime`: builds the module, runs the CLI (`selftest`, `plan`), starts the host, waits for `/health`, then calls `/api/selftest` and `/api/plan`.
- `scripts/verify-wasm.mjs` asserts the import allow-list and executes `selftest` through the real runtime, so a broken host layer fails fast.
- Docker image `llmcalc:wasi` runs the same server (read-only rootfs, `tmpfs /tmp`, all capabilities dropped) with a `HEALTHCHECK` on `/health` (spec 14).

## API reference

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/selftest
curl "http://127.0.0.1:8787/api/plan?weightsGB=16&kvGB=0.54&overheadGB=0.5&tps=1500&hourlyUsd=2.49"
curl "http://127.0.0.1:8787/api/kv?layers=32&batch=1&seq=4096&kvHeads=8&headDim=128&bytes=2&attn=0"
curl -X POST http://127.0.0.1:8787/api/compute -H 'content-type: application/json' \
     -d '{"command":"gpus","args":[20,24,0.9]}'
```

```json
{ "ok": true, "engine": "wasm-wasi", "runtime": "wasi-preview1", "command": "plan",
  "weightsGB": 16.0, "kvCacheGB": 0.54, "overheadGB": 0.50, "totalVramGB": 17.04,
  "tokensPerSecond": 1500.0, "costPerMillionTokens": 0.46 }
```

## Files

```
wasm/service.ts                WASI command module (AssemblyScript, zero-runtime)
scripts/lib/wasi-host.mjs      node:wasi adapter (instance, args, stdout capture)
scripts/wasi-run.mjs           CLI bridge
scripts/wasi-server.mjs        HTTP runtime host + dashboard
src/wasm/wasi-client.ts        browser client (relative URLs, timeouts)
src/wasm/use-kernel.ts         useWasiRuntime() polling hook
src/pages/Runtime.tsx          runtime status panel + "Run plan in WASI"
```
