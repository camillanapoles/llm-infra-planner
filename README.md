# LLMcalc — LLM Infrastructure Calculator

> A precision-first, fully client-side tool for estimating GPU memory, throughput, latency, and cloud costs for any LLM workload.

Built for ML engineers, infrastructure architects, and developers who need accurate hardware estimates — not ballpark guesses.

---

## What it does

LLMcalc answers the questions you actually have before deploying or training a large language model:

- **How much VRAM does this model need?** — broken down by weights, KV cache, activations, gradients, and optimizer states
- **Which GPU can run it?** — ranked by tier (Budget / Balanced / Performance) with utilization bars
- **What will it cost on cloud?** — sortable table across AWS, Azure, GCP, Lambda, RunPod, Vast, CoreWeave, Together AI
- **How fast will it run?** — tokens/sec estimate using the roofline model, with prefill/decode breakdown
- **What's the cheapest option per million tokens?** — cost efficiency metric computed automatically
- **How many concurrent users can it serve?** — capacity planning with SLO-aware TTFT and TPOT targets
- **What's the on-prem vs cloud TCO?** — full total cost of ownership with breakeven analysis
- **How do I set up the software stack?** — OS, driver, CUDA, PyTorch, container, and monitoring recommendations

Everything runs in the browser. No backend, no telemetry, no account required.

The calculation kernel is also compiled to **WebAssembly** (AssemblyScript → `wasm32`, ~2 KB, zero host imports) and used for the headline metrics, with the TypeScript implementation kept as a parity-tested fallback. The same kernel ships as a **WASI preview1 command module** that runs in a local runtime host (`node:wasi`), a container, or any WASI platform — see [/runtime](.kiro/specs/12-wasi-runtime.md) in the app.
<img width="2936" height="1668" alt="image" src="https://github.com/user-attachments/assets/072b10f6-7a8d-4537-ab32-3a06078e0a0a" />

---

## Features

### Workload Modes

| Mode | What it calculates |
|---|---|
| **Inference** | Weights + KV cache + overhead, throughput, cost per token |
| **Fine-tune** | Weights + activations + gradients + optimizer (LoRA / QLoRA / full) |
| **Train** | Full pre-training memory with gradient checkpointing |
| **Reverse** | Given a GPU, which models fit? |

### Calculation Engine

All formulas are pure TypeScript functions with no side effects, independently tested with property-based tests (244 tests across 19 test files).

| Component | Formula |
|---|---|
| Weight memory | `num_params × bytes_per_param / 1e9` |
| KV cache | `2 × layers × batch × seq_len × kv_heads × head_dim × bytes / 1e9` |
| Activation memory | `layers × seq × batch × hidden × (34 + 5×seq×heads/hidden) × 2` |
| Optimizer (Adam) | `14 × num_params` bytes |
| Throughput | `bandwidth_GBs / active_weights_GB × efficiency_factor` |
| Cost / 1M tokens | `(hourly_cost / (tok_per_sec × 3600)) × 1_000_000` |

Supports MoE (uses active params for throughput, total for VRAM), GQA, MQA, and MLA (DeepSeek compressed KV cache).

### Precision Options

| Format | Bytes/param |
|---|---|
| FP32 | 4.0 |
| FP16 / BF16 | 2.0 |
| INT8 / FP8 | 1.0 |
| INT4 | 0.5 |
| GGUF Q4\_K\_M | 0.606 |
| GGUF Q5\_K\_M | 0.711 |
| GGUF Q8\_0 | 1.0625 |

KV cache precision is set independently from weight precision.

### Model Database

513 models across 70+ families including Llama, Mistral, Qwen, DeepSeek, Gemma, Phi, Falcon, Cohere, Grok, InternLM, MiniCPM, SmolLM, Starcoder, Yi, and more. Each entry includes full architecture parameters: layers, hidden size, attention heads, KV heads, head dimension, max context length, attention type, and MoE configuration.

### GPU Database

147 GPUs across 12 vendors:

| Vendor | Coverage |
|---|---|
| NVIDIA | Consumer (RTX 20/30/40/50 series), Workstation (RTX Ada, RTX Pro), Datacenter (A100, H100, H200, B100, B200, GB200) |
| AMD | RDNA consumer (RX 7900 XTX), Instinct datacenter (MI300X, MI325X) |
| Apple Silicon | M1 through M4 variants (all chip tiers) |
| Intel | Arc consumer, Gaudi datacenter |
| Google | TPU v4, v5e, v5p |
| AWS | Trainium, Inferentia |
| Cerebras | WSE-2, WSE-3 (wafer-scale) |
| Groq | LPU |
| SambaNova | RDU |
| Tenstorrent | Grayskull, Wormhole |
| Qualcomm | Cloud AI 100 |
| Huawei | Ascend |

### Cloud Database

37 instances from 8 providers: AWS, Azure, GCP, Lambda, RunPod, Vast, CoreWeave, and Together AI — with on-demand and spot pricing.

### Advanced Panels

| Panel | What it provides |
|---|---|
| **KV Cache Config** | Precision picker, cache size curve chart, per-layer breakdown |
| **Concurrent Users** | Capacity planning with TTFT/TPOT SLO targets, log-scale slider up to 10K users |
| **Speculative Decoding** | Draft model, Medusa, EAGLE-2, EAGLE-3, Lookahead, Prompt Lookup — with speedup estimates and VRAM overhead |
| **Parallelism** | Tensor, pipeline, ZeRO-3, MoE parallelism strategies with topology diagram |
| **Cluster** | Multi-node sizing, interconnect (NVLink / InfiniBand / PCIe), cluster topology visualization |
| **Failover** | Replica redundancy and failover cost modeling |
| **TCO** | On-prem vs cloud total cost of ownership with breakeven analysis (capex, PUE, electricity, colo, staff) |
| **Storage** | Checkpoint size, disk IOPS requirements |
| **Network** | Bandwidth requirements for distributed training |
| **Power** | TDP-based power draw and energy cost estimates |
| **Tokenizer** | Vocab size, embedding VRAM, fertility rate per model |
| **Multimodal** | Vision encoder VRAM overhead for VLMs |
| **Dataset Estimator** | Training dataset size and token count estimation |
| **Format Recommendation** | Quantization format advisor based on VRAM budget |
| **Warmup** | Model load and warmup time estimates |
| **Request Cost** | Per-request cost breakdown by prompt/output token ratio |
| **Prefill/Decode Breakdown** | Separate prefill and decode throughput and latency |
| **Latency Curve** | Throughput vs latency tradeoff chart |
| **Batch Processing** | Offline batch throughput and cost modeling |
| **Auto-scale** | Replica auto-scaling thresholds and cost |

### Compare Mode

Add up to 3 configurations side-by-side. Numeric deltas are shown relative to the anchor config — green for improvement, red for regression — across VRAM, throughput, cloud cost, and cost per million tokens.

### Reverse Mode

Flip the calculator: pick a GPU (or enter custom VRAM), set a context length and workload mode, and see every model in the database ranked by fit status. Overflow models show the minimum precision required to fit.

### Shareable URLs

The full calculator state (model, precision, KV precision, context, batch, mode, concurrent users, SLO targets) is encoded in the URL. Share a link and the recipient sees exactly the same configuration.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` | Open model search |
| `⌘\` | Toggle dark / light mode |
| `⌘↵` | Copy share URL |
| `?` | Show all shortcuts |
| `i` `f` `t` `r` | Switch mode (Inference / Fine-tune / Train / Reverse) |
| `c` | Add current config to compare |
| `g` → `m` | Go to Models catalog |
| `g` → `h` | Go to Hardware catalog |
| `Esc` | Close dialog or drawer |

---

## Pages

| Route | Description |
|---|---|
| `/` | Main calculator |
| `/compare` | Side-by-side configuration comparison |
| `/reverse` | GPU → model fit grid |
| `/models` | Sortable, filterable model catalog |
| `/hardware` | Sortable, filterable GPU catalog |
| `/guides` | Methodology docs, quantization guide, glossary |
| `/runtime` | WebAssembly engine status, parity matrix, WASI host, deploy targets |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + Vite 5 + TypeScript |
| Styling | Tailwind CSS 3 + CSS custom properties |
| State | Zustand + nuqs (URL-as-state) |
| Routing | React Router v7 |
| Search | Fuse.js (fuzzy model search) |
| Formulas | KaTeX (rendered math) |
| Charts | Recharts |
| Tables | TanStack Table v8 |
| Icons | Lucide React |
| Testing | Vitest + fast-check (property-based tests, incl. wasm↔TS parity) |
| WebAssembly | AssemblyScript → `wasm32` (browser kernel) + `wasm32-wasi-preview1` (service) |
| WASI host | Node 20+ `node:wasi` (no native deps) — works with wasmtime/wasmedge/Spin too |
| Container | Docker (node:20-alpine → nginx:1.27-alpine, + node wasi runtime image) |
| CI/CD | GitHub Actions → GitHub Pages (3 environments) + GHCR images |
| Continuidade | Roadmap + política em `.kiro/state` + gate de escopo/estado (spec 17) |

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+

### Local Development

```bash
git clone https://github.com/kkpkishan/llm-infra-planner.git
cd llm-infra-planner
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Run Tests

```bash
# Unit + property-based tests
npm test

# Watch mode
npm run test:watch

# Validate data files against schemas
npm run validate

# WebAssembly kernel + WASI module
npm run build:wasm
npm run wasm:verify

# Page + WASI runtime together
npm run stack
```

### Production Build

```bash
npm run build
# Output in dist/
```

---

## Deployment

One codebase, four targets. Each target has a spec in `.kiro/specs/`.

| Target | How | URL |
|---|---|---|
| **Local** | `npm run stack` | http://localhost:5173 (+ WASI runtime on :8787) |
| **GitHub Pages · production** | push to `main` | https://camillanapoles.github.io/llm-infra-planner/ |
| **GitHub Pages · staging** | push to `staging` | https://camillanapoles.github.io/llm-infra-planner/staging/ |
| **GitHub Pages · dev** | push to `dev` | https://camillanapoles.github.io/llm-infra-planner/dev/ |
| **Docker** | `docker compose up -d` | http://localhost:3000 (+ wasi API on :8787) |

### Local runtime (page + WebAssembly compute service)

```bash
npm ci
npm run stack          # vite :5173  +  WASI runtime :8787 (proxied at /api/*)
# → open http://localhost:5173/runtime
```

```bash
npm run build:wasm       # compile the browser kernel + the WASI module
npm run wasm:verify      # 16 checks: sizes, exports, imports, selftest goldens
npm run wasi -- selftest # execute the wasm module in a WASI runtime (no server)
npm run wasi:serve       # runtime host only — dashboard on http://localhost:8787
npm run serve            # serve the built dist/ like nginx (SPA + /api proxy)
```

### GitHub Pages — three environments from one site

Push to a branch or dispatch the workflow; every run rebuilds all three environments
(each from its own branch) and deploys them as one Pages artifact, so a `dev` deploy
can never wipe production.

```bash
gh workflow run deploy-pages.yml                                   # all environments
gh workflow run deploy-pages.yml -f ref=my-feature -f environments=dev
# → dev is built from my-feature, staging/production keep their branches (no push needed)

npm run build:pages -- --env all --out _site   # build/verify the artifact locally
npm run serve:pages                            # http://localhost:4173/{,staging/,dev/}
```

First-time setup (branches, environments, Pages) is a workflow, not a manual step:
`Actions → Bootstrap repository → Run workflow` creates `dev`/`staging`, prepares the
GitHub Environments and dispatches the deploys (spec `16-branch-environments-bootstrap.md`).

### Docker / nginx

```bash
docker compose up -d                                  # page :3000 + wasi runtime :8787
docker compose --profile staging --profile dev up -d  # + staging :3001 + dev :3002
docker compose up -d wasi                             # compute service only

# single images
docker build --target runner --build-arg APP_ENV=dev --build-arg BASE_PATH=/dev/ -t llmcalc:dev .
docker build --target wasi -t llmcalc:wasi .

npm run deploy:docker     # static validation everywhere, build+smoke where docker exists
```

The `runner` image is nginx serving the bundle (hardened config, `/wasm/*` as
`application/wasm`, SPA fallback, security headers) with `/api/*` proxied to the
`wasi` service. The `wasi` image runs `scripts/wasi-server.mjs` on Node with no
dependencies — every `/api` request is executed inside `llmcalc-wasi.wasm`.

### Continuidade entre branches (state-driven)

O projeto carrega o próprio estado: escopo, progresso e ponto de retomada ficam em
`.kiro/state/` e um gate de CI garante que cada branch continue de onde a anterior
parou. Porta de entrada: [`CONTINUITY.md`](CONTINUITY.md).

```bash
npm run continuity:status     # fase atual, progresso, próximas tarefas
npm run continuity:start -- --task T-402   # declara o escopo desta branch
npm run continuity:start -- --auto         # ou infere do nome da branch (#401, spec, …)
npm run continuity:check      # gate (o mesmo que bloqueia o PR)
npm run continuity:sync       # mede testes/wasm/build/lint e atualiza o estado
npm run continuity:resume     # briefing de retomada para a próxima sessão
```

- **Ponto de retomada:** [`.kiro/state/RESUME.md`](.kiro/state/RESUME.md) · **estado:** [`.kiro/state/STATE.md`](.kiro/state/STATE.md)
- **Escopo por branch:** `.kiro/state/branches/<slug>.json` (criado automaticamente
  pelo gate no primeiro push do PR). Sem `--task`, o escopo é inferido do roadmap: o
  nome da branch pode citar a tarefa (`feat/401-…`), o spec (`wasi-runtime`) ou nada —
  e a branch **herda o ponto de retomada** (primeira tarefa aberta sem bloqueio) em vez
  de falhar. `main`/`dev`/`staging` são promoções: não têm escopo de arquivo.
- **Gate:** `.github/workflows/continuity-gate.yml` reprova PR fora do escopo, com
  tarefa inexistente, com roadmap desatualizado ou com mudança no núcleo wasm/TS
  que não foi revalidada. A label `scope:allow` libera expansão intencional.
- **Consolidação:** `.github/workflows/continuity-sync.yml` mede os invariantes
  (wasm:verify, testes, build, lint, docker, artefato de Pages) no merge para a
  `main` e publica o estado — que a página mostra em `/runtime`.

### WebAssembly engines

| Engine | Artifact | Where it runs | Fallback |
|---|---|---|---|
| Browser kernel | `public/wasm/llmcalc-kernel.wasm` (~2 KB, no imports) | page (all metric math) | `src/lib/formulas` (parity-tested) |
| WASI service | `wasi/dist/llmcalc-wasi.wasm` (~5.6 KB, preview1 command) | `npm run wasi`, `npm run wasi:serve`, docker, any WASI host | — |

`wasmtime run wasi/dist/llmcalc-wasi.wasm -- plan 16 0.54 0.5 1500 2.49` also works.

---

## Project Structure

```
src/
├── components/
│   ├── calculator/     # All calculator UI components (50+ components)
│   ├── feedback/       # Toast, EmptyState, ErrorState, Skeleton
│   ├── layout/         # TopBar, ModeTabsBar, PageShell, Footer
│   └── primitives/     # Button, Input, Slider, Dialog, Popover, etc.
├── wasm/
│   └── service.ts      # WASI preview1 command module (same kernel)
├── data/
│   ├── models.json     # 513 LLM architecture specs
│   ├── gpus.json       # 147 GPU specs with pricing
│   ├── cloud.json      # 37 cloud instance pricing entries
│   └── meta.json       # Data version and build timestamp
├── lib/
│   ├── formulas/       # Pure calculation kernel (40+ formula modules) — the TS oracle
│   ├── keyboard-shortcuts.ts
│   ├── url-serializer.ts
│   ├── env.ts          # Build environment model (local/dev/staging/production)
│   └── use-theme.ts
├── wasm/
│   ├── kernel.ts       # WebAssembly kernel (AssemblyScript) — browser engine
│   ├── kernel.test.ts  # parity vs src/lib/formulas (property-based)
│   ├── use-kernel.ts   # React bindings + benchmark
│   └── wasi-client.ts  # /api client for the WASI runtime host
├── pages/Runtime.tsx   # engine, parity matrix, WASI status, deploy targets
├── pages/              # Home, Compare, Reverse, Models, Hardware, Guides
├── store/              # Zustand calculator store
└── styles/             # Tailwind config, design tokens, globals
scripts/
├── ingest-models.ts         # HuggingFace model ingestion pipeline
├── refresh-cloud-prices.ts
├── refresh-hardware.ts
├── validate-data.ts         # Build-time JSON schema validation
├── build-wasm.mjs           # compiles wasm/kernel.ts + wasm/service.ts
├── verify-wasm.mjs          # CI gate for both wasm artifacts
├── wasi-run.mjs             # CLI: run the wasm module in a WASI runtime
├── wasi-server.mjs          # HTTP runtime host (/api/*, dashboard)
├── dev-stack.mjs            # npm run stack — page + runtime
├── serve-static.mjs         # nginx/Pages stand-in for built artifacts
├── build-pages-artifact.mjs # production + staging + dev → _site/
├── docker-build.mjs         # image build / static validation
├── continuity.ts            # estado do projeto: check · sync · start · resume
└── lib/continuity-core.ts   # lógica do gate (escopo, progresso, roadmap)
.kiro/state/
├── roadmap.json             # fases, tarefas, escopo por caminho (fonte de verdade)
├── policy.json              # regras do gate
├── project-state.json       # estado derivado + invariantes medidos
├── STATE.md / RESUME.md     # estado e ponto de retomada (gerados)
└── branches/<slug>.json     # handoff de escopo de cada branch
```


---

## Data

All data is static JSON bundled with the app. No runtime API calls are made.

- **Models** — sourced from HuggingFace `config.json` files via the ingestion pipeline, with manual overrides for MoE active parameters and MLA compressed dimensions
- **GPUs** — MSRP / street prices, memory bandwidth, FP16 TFLOPS, TDP
- **Cloud** — on-demand and spot pricing with `lastPriceUpdate` timestamps

To update data, edit the JSON files in `src/data/` and run `npm run validate` to check schema compliance.

To re-ingest models from HuggingFace:

```bash
npx tsx scripts/ingest-models.ts
```

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make changes and add tests
4. Run the gates: `npm run wasm:verify && npm test && npm run build`
5. Open a pull request (CI also lints the files you touched)

Touching the calculation kernel? `wasm/kernel.ts` and `src/lib/formulas/*` must stay
numerically identical — `src/wasm/kernel.test.ts` fails otherwise, and that is
intentional (`npm run wasm:verify` gates the artifacts themselves).

---

## License

MIT
