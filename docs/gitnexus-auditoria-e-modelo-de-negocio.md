# Auditoria com GitNexus + Modelo de Negócio — LLMcalc

> Estudo de governança/engenharia do repositório `camillanapoles/llm-infra-planner`
> feito com **GitNexus 1.6.12 instalado localmente** (`npm install --no-save gitnexus@1.6.12`,
> sem alterar `package.json`). Data: 2026-10-19.

## 1. GitNexus: o que foi indexado

| Métrica | Valor |
|---|---|
| Arquivos indexados | 244 |
| Nós (símbolos) | 5.062 |
| Arestas (relações) | 10.203 |
| Clusters/comunidades | 185 |
| Fluxos de execução (processes) | 195 |
| Rotas | 8 |
| Commit indexado | `da0bb3a` (status: up-to-date) |

Comandos usados: `gitnexus analyze .`, `status`, `list`, `cypher`, `context useCalculatorStore`,
`check --cycles`. Limitação honesta: a extensão FTS/LadybugDB não baixou neste sandbox
(SSL), então `gitnexus query` (BM25) ficou degradado — a análise usou Cypher/context/graph,
que funcionam sem FTS. `check --cycles` apontou **1 ciclo**: `scripts/agent.ts ↔ scripts/lib/continuity-core.ts`.

## 2. O que o projeto é (objetivo global)

**LLMcalc** — calculadora client-side de infraestrutura para LLMs: dado um modelo/cenário,
responde VRAM necessária, GPU adequada, custo em 8 nuvens, throughput/latência e capacidade
de usuários. Catálogos: **513 modelos, 147 GPUs (12 vendors), 37 instâncias de nuvem**.
Sem backend, sem telemetria, sem conta; estado compartilhável via URL.

## 3. Padrões de design e engenharia identificados

| Padrão | Onde |
|---|---|
| **Funções puras / kernel funcional** | `src/lib/formulas/*` — sem efeitos colaterais, testadas isoladas |
| **Dual implementation + paridade (Adapter/Fallback)** | kernel AssemblyScript→WASM (`wasm/`) com fallback TypeScript numericamente idêntico, provado por testes |
| **URL-as-State** | `nuqs` + `src/lib/url-serializer.ts` (round-trip testado, aliases legados) |
| **Store central (Observer)** | Zustand `src/store/calculator-store.ts` (`useCalculatorStore`, ~550 linhas) |
| **Catálogo como dados (Repository)** | `src/data/*.json` validados por schema (`npm run validate`) |
| **Strategy** | precisões (FP16/INT4/GGUF…), paralelismo (TP/PP/ZeRO), speculative decoding |
| **Composition de painéis** | 50+ componentes em `src/components/calculator/` sobre primitivas |
| **Gate-driven pipeline / State-driven governance** | `.kiro/state/{roadmap,policy,project-state}.json`, `scripts/continuity.ts`, `scripts/pipeline.ts` com contrato JSON e exit 0/1/2 |
| **Property-Based Testing** | Vitest + fast-check (paridade wasm↔TS, fórmulas) |
| **Multi-target build** | Vite (Pages), Docker (nginx + WASI `node:wasi`), local — mesmo kernel |

## 4. Pendências e lacunas (fonte: `.kiro/state`, `ENTREGA.md` §9)

Roadmap: **25/39 tarefas (64%)** — P1/P2 concluídas; P3 em 85%.

| ID | Lacuna |
|---|---|
| T-308 | Publicar os 3 ambientes pós-merge (Pages depende de habilitação manual do dono) |
| T-412 | Smoke test da imagem Docker puxada do GHCR |
| T-401/T-403/T-404/T-405 | e2e Playwright, code-splitting (bundle ~700 kB), cobertura store/rotas, acessibilidade |
| T-501/T-502/T-503 | Dados vivos: validar refresh de preços, alerta de dados defasados, i18n PT-BR/EN |
| T-601–T-603 | WASM avançado: SIMD, Web Worker, deploy WASI serverless |
| T-701/T-702 | Release v1.0 + doc de contribuição com o gate |

Não-pendências (decisão de produto): sem backend/telemetria; push ao GHCR é opt-in.

## 5. Modelo de negócio (resumo — apresentação completa em `apresentacao/`)

- **Valor:** transformar dimensionamento de GPU/nuvem (decisão de milhares de US$) em uma conta de segundos, precisa e compartilhável por link.
- **Clientes:** engenheiros de ML/infra, CTOs/arquitetos (TCO on-prem vs nuvem), fundadores (custo/token), compras (comparar 8 nuvens).
- **Hoje:** gratuito/aberto, client-side — fase de adoção/autoridade.
- **Receita futura (hipóteses, não implementadas):** Pro/Times, API/WASI hospedado, white-label/embed, dados/patrocínio de catálogo.
- **Moat:** catálogo validado (513×147×37) + confiança numérica (paridade WASM↔TS) + distribuição via URL.

## 6. Entregas desta tarefa

1. GitNexus 1.6.12 instalado localmente e índice gerado (`.gitnexus/`, ignorado pelo git).
2. Apresentação somente do modelo de negócio: [`apresentacao/modelo-de-negocio.html`](../apresentacao/modelo-de-negocio.html)
3. Nova GitHub Action que a valida e publica como artefato:
   **https://github.com/camillanapoles/llm-infra-planner/actions/workflows/presentation.yml**
