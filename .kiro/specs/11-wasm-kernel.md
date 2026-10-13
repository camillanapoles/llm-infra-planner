# SPEC 11: WebAssembly Calculation Kernel

## Description

The calculator's numeric core (weights, KV cache, roofline throughput, latency, cost per million tokens, VRAM aggregates) is compiled from AssemblyScript to WebAssembly and executed **in the browser**. The TypeScript implementation in `src/lib/formulas/*` stays as the reference oracle and as a transparent fallback, so the UI can never break because a `.wasm` file is missing.

Two engines, one API — `KernelApi` in `src/wasm/kernel.ts`:

| Engine | Source | Artifact | When |
|---|---|---|---|
| `wasm` | `wasm/kernel.ts` (AssemblyScript) | `public/wasm/llmcalc-kernel.wasm` (~2 KB) | whenever the module loads |
| `js` | `src/lib/formulas/*` | bundled JS | fallback, and the parity oracle in tests |

## Requirements

### Requirement 1: Compilable, dependency-free kernel
**User Story:** As an maintainer, I want a tiny deterministic kernel module with no host imports, so it instantiates instantly and behaves identically on every runtime.

**Acceptance Criteria:**
- `wasm/kernel.ts` compiles with `asc -O3s --runtime stub --noAssert` to a module **< 32 KB** (currently ~2.0 KB).
- The module **imports nothing** (`WebAssembly.Module.imports()` is empty) and exports every function of the `KernelApi` surface:
  `weightsGB`, `weightsBytes`, `kvCacheGB`, `kvCacheBytes`, `kvBytesPerToken`, `throughputTps`, `tpotMs`, `ttftMs`, `costPerMillionTokens`, `totalVramInference`, `totalVramTraining`, `adamOptimizerBytes`, `gradientBytes`, `gpuCountFor`, `concurrentSequences`, `requestLatencyMs`.
- Boundary types are only `f64` / `i32` — no strings, no structs, no allocation, so no GC or allocator is pulled in.
- Rounding happens **inside** the kernel exactly as the TS engine does it: weights to 1 decimal, KV cache to 2, TTFT/throughput to integers, cost to 2.
- Attention is encoded as `0 = mha/gqa`, `1 = mqa`, `2 = mla`; `mla` uses `mlaCompressedDim` and drops the ×2 factor (DeepSeek-style compressed cache).
- `npm run build:wasm` rebuilds both modules and writes `public/wasm/manifest.json` (sizes, targets, `builtAt`).
- `npm run build:wasm:kernel` rebuilds only the browser kernel (fast path for UI work).

### Requirement 2: Transparent browser loading with fallback
**User Story:** As a user, I want the page to work even if the wasm artifact is unavailable, without any visible failure.

**Acceptance Criteria:**
- `loadKernel()` fetches `${import.meta.env.BASE_URL}wasm/llmcalc-kernel.wasm` (base-path aware for GitHub Pages sub-paths).
- A response that is not a wasm module (HTML 404 page, truncated file) is rejected via magic-byte check and falls back to `jsKernel`.
- The load is **memoized** (`getKernel()`), so the store and the Runtime page share one fetch + one compile per page load.
- On success the store swaps `activeKernel` and recomputes; the numbers cannot change because wasm ≡ TS is enforced by tests.
- Failures surface as data, not exceptions: `KernelStatus { engine, wasmLoaded, bytes, compileMs, instantiateMs, url, error? }`.
- The header shows a chip (`WASM` / `JS`) linking to `/runtime` with a tooltip describing module size and parity verdict.

### Requirement 3: Provable parity with the TypeScript engine
**User Story:** As a maintainer, I want to be certain the wasm path can never disagree with the reference implementation.

**Acceptance Criteria:**
- `src/wasm/kernel.test.ts` instantiates the **built artifact** (self-healing: it runs the build if missing) and asserts:
  - module shape: no imports, all exports present, size budget;
  - golden vectors documented in the README (`8B/fp16 → 16 GB`, `32L·4K·8kv·fp16 → 0.54 GB`, `3350 GB/s · 16 GB active → 177 tok/s`, `20 GB on 24 GB → 1 GPU`);
  - property-based parity (fast-check, 200–250 runs each) against `computeWeightMemory`, `computeKVCache` (mha/gqa/mqa/mla), `computeThroughput` and `computeCostMetrics`;
  - `jsKernel` ≡ wasm on aggregate/latency helpers.
- `scripts/verify-wasm.mjs` (`npm run wasm:verify`) is the CI gate: artifacts exist, size budgets, export surface derived from the TS interface, WASI imports confined, `selftest` golden values.
- CI (`.github/workflows/ci.yml`) runs `build:wasm` → `wasm:verify` → `npm test` on every push/PR, so a parity regression blocks the merge.

### Requirement 4: Engine observability in the UI
**User Story:** As a user, I want to see which engine produced my numbers and how fast it is.

**Acceptance Criteria:**
- `/runtime` shows, live in the tab: engine, module size, compile/instantiate time, and the **parity matrix** (WebAssembly vs TypeScript value, Δ, verdict) for 14 golden cases.
- A benchmark chip compares JS vs wasm on `throughputTps` over 200 000 calls (ms + speedup).
- The page shows which engine computed the current calculator state (engine, verified, failures, model, context, VRAM, KV, cost/1M, TTFT).
- `src/pages/Runtime.test.tsx` renders the page in both states (module available; behaviour when the fallback is used) under happy-dom.

## Files

```
wasm/kernel.ts                 AssemblyScript kernel (source of truth for wasm)
scripts/build-wasm.mjs         dual-target builder (kernel + WASI) + manifest
scripts/verify-wasm.mjs        CI gate
src/wasm/kernel.ts             loader, jsKernel fallback, parity harness, benchmark
src/wasm/use-kernel.ts         React bindings (useKernel, benchmarkKernels)
src/wasm/kernel.test.ts        shape + golden + property parity tests
src/pages/Runtime.tsx          engine + parity + deploy targets UI
src/store/calculator-store.ts  activeKernel swap + engine state
```

## Verification

```bash
npm run build:wasm        # compiles both targets
npm run wasm:verify       # 16 checks (sizes, exports, imports, selftest goldens)
npm test                  # includes ~950 fast-check assertions of wasm ≡ TS parity
npm run stack             # then open /runtime and inspect the parity matrix
```
