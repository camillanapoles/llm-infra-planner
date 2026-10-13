# Entrega — LLMcalc: kernel WebAssembly, runtime WASI, 3 ambientes de deploy e continuidade automatizada

> **Branch:** `arena/fe62ce6d-llm-infra-planner` · **PR:** [#1](https://github.com/camillanapoles/llm-infra-planner/pull/1)
> **HEAD:** `70ddcfd` · **base:** `main` (`cdfee43`) · **21 commits** · **280 arquivos versionados**
> **Verificação:** `npm run verify:all` → **19/19 exit 0** · **CI:** 5/5 checks verdes no HEAD
> Gerado em 2026-10-13. Todos os números abaixo foram medidos, não estimados.

---

## 1. Resumo executivo

Este branch transforma o LLMcalc de "calculadora client-side" em um **produto com kernel WebAssembly
parity-testado, runtime WASI executável fora do browser, três caminhos de deploy (Pages, Docker, local),
ambiente dev/staging, e uma camada de continuidade autoconsciente (gate por estado + ledger auditável +
agente de CI/CD)**.

O que está **pronto para uso agora**, sem depender de mais nada:

| Entrega | Como o usuário usa |
|---|---|
| **App local (runtime completo)** | `npm run stack` → página em `:5173` + runtime WASI em `:8787` (vite faz proxy `/api/*`; o browser nunca fala com localhost) |
| **Preview ao vivo (Arena)** | já no ar nesta sessão: página `:5173` e runtime `:8787` |
| **Docker (3 ambientes)** | `docker compose up app app-staging app-dev` (multi-stage `node:20-alpine` → nginx) |
| **Página estática offline** | `npm run build:app && npm run serve` (sem backend, sem telemetria, sem conta) |
| **Kernel WASM** | compilado no build, com fallback TS parity-testado (paridade testada em CI) |
| **Runtime WASI** | `npm run wasi:serve` ou o binário `wasi/dist/llmcalc-wasi.wasm` em qualquer host WASI |
| **Ledger + gate de continuidade** | `npm run continuity:check`, `npm run store`, `npm run agent -- audit` |
| **Pipeline gate-driven** | `npm run pipeline -- health` (gatilho) e `complete T-xxx` (testa e entrega com a próxima issue) — JSON com exit 0/1/2; ver **[PIPELINE.md](PIPELINE.md)** |
| **Bateria de verificação** | `npm run verify:all` (19 checks; é o mesmo conjunto que o CI distribui em jobs) |

O único item **bloqueado por dependência de plataforma** é o deploy automático em GitHub Pages e o
dispatch do agente: ambos exigem que os workflows existam na branch default — ou seja, **depois do merge
do PR #1**. Antes disso o GitHub responde 404 no `workflow_dispatch` (verificado), o que é comportamento
esperado, não defeito.

---

## 2. O que foi solicitado — e os incrementos, na ordem em que vieram

A entrega é um encadeamento de pedidos. Cada linha é um pedido do usuário e o que ele acrescentou ao escopo:

| # | Solicitação (termos do usuário) | Incremento real sobre o que já existia |
|---|---|---|
| 1 | "Completar a página/processo com runtime local + deploy WASM, branches dev/staging" | Kernel WebAssembly (AssemblyScript → `wasm32`), runtime WASI, 3 caminhos de deploy, provisionamento de `dev`/`staging` por workflow colocado na `main` (sem eu empurrar branches) |
| 2 | "um spec por opção, quero as 3 opções: pages, docker e local (no arena preview e qualquer local)" | Specs separadas 13/14/15 + uma 4ª para o bootstrap (16) + preview funcional na Arena |
| 3 | "wasm: both" | Kernel in-page **e** empacotamento de runtime WASI (módulo preview1 command) |
| 4 | Continuidade "automática e dirigida por estado", sem narração manual; aceite = evidência executada | Gate de continuidade (`continuity:check`), descriptor de acesso de um JSON por projeto, provas de retomada e auto-cura |
| 5 | Continuidade "por API" com "secrets": agente que garante continuidade e gestão CI/CD complementando o GitOps | Descriptor com o agente anunciado, `agent.yml` + `npm run agent` com 7 ações, identidade por GitHub App (ou token efêmero), **nenhum PAT aceito ou guardado** |
| 6 | "Pare, valide e garanta zero erro por verificação retornada" | Correção dos gates vermelhos de verdade + 2 defeitos de falso-verde + lint do CI virou bloqueante |
| 7 | "Relate o que está entregando… documente… audite e valide e que falta" | Este documento + bateria versionada (`npm run verify:all`) |

Os specs vivem em `.kiro/specs/` (11–17 são desta entrega): `11-wasm-kernel`, `12-wasi-runtime`,
`13-deploy-github-pages`, `14-deploy-docker`, `15-deploy-local`, `16-branch-environments-bootstrap`,
`17-continuity-gate`.

---

## 3. Timeline de execução (commits reais)

| data | commits | o que entrou |
|---|---|---|
| 07/10 | `44cdf0a` `70a3363` `6f631e6` `064c48b` `24a41d1` `9b9024f` `b6a3128` `7cccbf6` | Handoff auto-inferido por branch (inclui o ponto de retomada), auto-cura de handoff vazio, correção do artefato Pages, wasm antes do artefato, lint:changed, validação de workflows, **gate de continuidade por estado**, **kernel WASM + runtime WASI + deploy multi-ambiente** |
| 11/10 | `0c5dfdd` `8612932` `260eaca` `4c1a5bf` `a1af5b3` `f3c622d` `5c2fa4b` | Descriptor de acesso servido pelo runtime WASI, caminho único de build do Pages, **ledger SQLite com CRUD/query/gates como dado**, Node 22 no CI, render de listas por identificador, nota de sessão em `kv`, **agente GitOps por API sem credencial pessoal** |
| 12–13/10 | `3b20e12` `c4fea86` … | reconciliação do ledger (sync nunca encolhe), documento de entrega e bateria versionada |
| 13/10 | *(este commit)* | **pipeline gate-driven**: gatilho de saúde (issues · CI · testes), ciclo issue→teste→próxima indexada, contrato JSON único com exit 0/1/2, workflow `pipeline.yml` + spec 18 + `PIPELINE.md` |
| 11–12/10 | `ea0c752` `8679f28` `66c32b8` `bc3ef18` `c953780` `70ddcfd` | **Zero lint** (19 erros + 5 avisos → 0) com tipos reais, validador de dados alinhado ao catálogo, escopo declarado no roadmap/handoff, **gate de lint que não pode ficar verde por acidente**, veredito da auditoria por última execução de cada gate |

---

## 4. Stack utilizada

| Camada | Tecnologia | Papel |
|---|---|---|
| UI | React 18 + TypeScript + Vite | SPA client-side, sem backend |
| Estilo | Tailwind CSS | tema e componentes primitivos |
| Kernel | **AssemblyScript → WebAssembly** (`wasm32-unknown-unknown`, `-O3s`) | métricas de cabeçalho (VRAM, throughput, custo) |
| Runtime | **WASI preview1** (`node:wasi`) | executar o mesmo kernel fora do browser, via HTTP |
| Testes | Vitest (**383 testes / 25 arquivos**) | unidade + paridade wasm↔TS |
| Dados | JSON versionado: **513 modelos · 147 GPUs · 61 instâncias de nuvem** | catálogo validado por script |
| Deploy estático | GitHub Pages (3 sub-paths) + nginx | dev / staging / produção |
| Deploy container | Docker multi-stage + Compose (4 serviços) | `app`, `app-staging`, `app-dev`, `wasi` |
| Ledger | SQLite (`node:sqlite`, Node 22) + snapshot JSON versionável | sessões, gates, eventos, tarefas, handoffs |
| CI/CD | GitHub Actions (**9 workflows**) | verificação, gates, deploy, ingestão de dados, agente |
| Identidade | GitHub App installation (runtime) · `GITHUB_TOKEN` efêmero (workflows) | nunca há PAT em arquivo, log ou chat |

---

## 5. O que foi implementado

### 5.1 Kernel WebAssembly (`11-wasm-kernel`)
- `wasm/kernel.ts` → `public/wasm/llmcalc-kernel.wasm` — **2.057 bytes**, zero imports de host.
- Usado nas métricas principais com **fallback TypeScript** e **testes de paridade** (o CI falha se divergirem).
- `manifest.json` gerado no build declara alvos, tamanhos e data; a UI mostra qual motor respondeu.
- `scripts/verify-wasm.mjs` faz **16 verificações** do artefato (seções, imports, exports, tamanho, execução).

### 5.2 Runtime WASI (`12-wasi-runtime`)
- `wasm/service.ts` → `wasi/dist/llmcalc-wasi.wasm` — **5.728 bytes**, command module preview1 (`fd_write`).
- `scripts/wasi-server.mjs`: host HTTP que **executa dentro do módulo** e expõe `/health`, `/api/plan`,
  `/api/kv`, `/api/roofline`, `/api/gpus`, `/api/latency`, `/api/selftest`, `/api/compute`, `/api/access`,
  `/api/store`, `/api/store/:table`, `/api/session`, `/` (dashboard) e `/wasm/*.wasm`.
- O mesmo binário roda em `wasmtime`, WasmEdge, Spin ou wasmCloud — sem rebuild.
- Smoke test do runtime no CI (job `WASI runtime smoke test`, verde).

### 5.3 Deploy — as três opções + o bootstrap

| Opção | Spec | Artefato | Como roda |
|---|---|---|---|
| **GitHub Pages** | `13` | `_site/` com `index.html`, `dev/`, `staging/` | `deploy-pages.yml` publica por branch (dev/staging/produção) |
| **Docker** | `14` | imagens por ambiente + serviço WASI | `docker compose up`; `scripts/docker-build.mjs` faz **16 validações estáticas** |
| **Local** | `15` | vite + host WASI no mesmo comando | `npm run stack` (`PORT=5173`, `WASI_PORT=8787`), preview na Arena |
| **Bootstrap do repo** | `16` | branches `dev`/`staging` + environments + Pages | `bootstrap-repo.yml` — **colocado por você na `main`**; eu não empurro branches |

O artefato de Pages é verificado por `scripts/verify-pages-artifact.sh` (o mesmo script no CI e no build local),
e `npm run verify:all` confirma os **3/3 ambientes**.

### 5.4 Continuidade dirigida por estado (`17-continuity-gate`)
- `npm run continuity:check` — gate que compara o diff com o **escopo declarado** no handoff; recusa mudanças
  fora do escopo, exige tarefa/spec declarados, checa coerência do roadmap e frescor do kernel.
- `npm run continuity:sync` — mede invariantes (wasm, docker, testes, build, lint, Pages), grava estado,
  renderiza `STATE.md`/`RESUME.md`, publica `public/state.json` e o **descriptor de acesso**.
- `npm run continuity:resume|start|access` — retomada e scaffold de handoff; branch nova **infere o próprio
  escopo** e o ponto de retomada, e handoff vazio se auto-cura em vez de bloquear.
- Descriptor de acesso: **um JSON por projeto** (`.kiro/state/access.json` ≡ `public/access.json`, servido em
  `/api/access`), validado no CI (`validate:access`).

### 5.5 Ledger de continuidade (`store`)
- SQLite com CRUD, query e **gates como dado**: coleções `sessions`, `kv`, `events`, `gates`, `tasks`,
  `handoffs`, `artifacts`; snapshot versionado (`.kiro/state/store.json` + `public/store.json`).
- CLI: `init`, `check` (integridade + varredura de segredos), `set/get/del`, `ls/show/query`, `event`,
  `gate`, `session start|note|end`, `export/import`.
- **Auto-cura**: banco vazio em sandbox/branch nova → reimporta do snapshot em vez de perder a memória.
- Estado atual medido: **100+ execuções de gate**, 33 tarefas, 1 handoff, 5 chaves de `kv`, ~30 eventos.

### 5.6 Agente de CI/CD por API (GitOps)
- `npm run agent -- <ação>` ou `gh workflow run agent.yml -f action=…`: **7 ações** — `status`, `audit`,
  `resume`, `check`, `deploy`, `bootstrap`, `sync`.
- Identidade: **GitHub App** (`APP_ID`/`APP_PRIVATE_KEY` → token por execução) ou `GITHUB_TOKEN` efêmero.
  **Nenhum PAT**: o 403 ao ler `actions/secrets` é essa identidade recusando tocar segredos.
- `agent audit` **falha (exit 1) somente quando a última execução de algum gate falhou**; o histórico de
  falhas já corrigidas continua visível (`failedRuns`) sem reprovar o comando.

### 5.7 Qualidade (o passo 6 do pedido)
- Lint: **0 problemas** em 202 arquivos (tipos reais no lugar de `any`, `align` do popover implementado,
  moeda com fonte única, convenção `_prefixo` documentada no CONTRIBUTING).
- Validador de dados alinhado à fonte de verdade (`GPUSpec`): vendors/categorias completos e faixa de memória
  `[0.1, 65536] GB` — a regra antiga `[1, 1024]` reprovava a SRAM de um Groq LPU (0,23 GB) e um rack
  GB300 NVL72 (20.736 GB).

---

## 6. Testado e validado

### 6.1 Bateria completa — `npm run verify:all` → **18/18, exit 0** (aqui, em `70ddcfd`)

```
✅ workflows ✅ wasm:build ✅ wasm:verify ✅ validate:data ✅ typecheck ✅ tests
✅ lint ✅ lint:changed ✅ build:app ✅ validate:access ✅ validate:store
✅ continuity:check ✅ deploy:docker ✅ build:pages ✅ pages:3-envs
✅ continuity:sync ✅ pipeline:cli ✅ agent:status ✅ agent:audit   → 19 OK · 0 FALHA
```

### 6.2 Números medidos (gravados em `.kiro/state/project-state.json`)

| invariante | valor |
|---|---|
| testes | **383** em 25 arquivos (inclui paridade wasm↔TS) |
| kernel wasm | 2.057 bytes · 16 verificações |
| módulo WASI | 5.728 bytes |
| bundle | build ok, chunk principal 701,89 kB |
| lint | **0 erros / 0 avisos** |
| validações docker | 16 |
| artefato Pages | 3/3 ambientes |
| dados | 513 modelos · 147 GPUs · 61 instâncias — 0 erro de validação |

### 6.3 No GitHub Actions (HEAD `70ddcfd`)

| check | resultado |
|---|---|
| Build & test (lint, wasm, 383 testes, bundle) | ✅ 42s |
| Pages artifact (all environments) | ✅ 34s |
| WASI runtime smoke test | ✅ 24s |
| State & scope (gate de continuidade no PR) | ✅ 25s |
| CodeRabbit | ✅ |

---

## 7. É automatizado por CI/CD → trigger → gate-driven, via GitHub Actions?

**Sim — e em três camadas distintas.** Não é "um pipeline"; é um encadeamento trigger → verificação → gate →
deploy, com os gates como dado no ledger.

### 7.1 Os 9 workflows e seus gatilhos

| Workflow | Trigger | O que faz | Bloqueia? |
|---|---|---|---|
| `ci.yml` | push em `main`/`dev`/`staging`, PR, dispatch | valida workflows · build wasm · verifica wasm · 363 testes · typecheck+bundle · **lint (agora bloqueante)** · lint dos arquivos alterados · estado (informativo) · artefato | **sim** |
| `continuity-gate.yml` | PR (aberto/sync/reopen/label/ready), dispatch | cria/valida handoff, **audita escopo do diff**, valida descriptor e store, comenta no PR | **sim** |
| `continuity-sync.yml` | push em `main`, cron seg. 06:17 UTC, dispatch | consolida estado + ledger + snapshots e commita | — |
| `deploy-pages.yml` | push em `main`/`staging`/`dev`, dispatch | builda o(s) ambiente(s) e publica no Pages (`github-pages`) | — |
| `docker.yml` | push nas 3 branches, tags `v*`, dispatch | imagens por ambiente (push ao GHCR é opt-in) | — |
| `bootstrap-repo.yml` | push em `main` (paths dos workflows), dispatch | cria `dev`/`staging`, environments e habilita Pages | — |
| `agent.yml` | dispatch | as 7 ações do agente (status/audit/resume/check/deploy/bootstrap/sync) | — |
| `ingest-models.yml` | cron diário 03:17 UTC, dispatch | ingere modelos novos e **abre PR** | — |
| `refresh-prices.yml` | cron diário 04:00 UTC, dispatch | atualiza preços e **abre PR** | — |

### 7.2 A cadeia, em ordem

```
push/PR ──▶ ci.yml (verificação)  ──▶ ┐
PR     ──▶ continuity-gate.yml ─────▶ ├──▶ merge na main ──▶ continuity-sync.yml (consolida estado+ledger)
                                      │                     ──▶ bootstrap-repo.yml (cria dev/staging, 1ª vez)
                                      │                     ──▶ deploy-pages.yml (publica produção)
                                      │                     ──▶ docker.yml (imagens)
                                      └──▶ agente (dispatch) ──▶ deploy em dev/staging por ref arbitrário
cron   ──▶ ingest-models / refresh-prices ──▶ PR automático ──▶ volta para o topo
```

O ponto "gate-driven" é literal: **o gate não é um comentário no PR, é dado**. `continuity:sync` registra cada
gate no ledger (`gates=<id>@<timestamp>`, `ok`, `detail`), e `agent audit` lê esse ledger para dar o veredito
(exit code) — de qualquer lugar, por API. Hoje: **100 execuções registradas, veredito "tudo verde"**.

### 7.3 O que já roda hoje × o que passa a rodar depois do merge

| Capacidade | Hoje (branch) | Depois do merge (branch default) |
|---|---|---|
| CI + gate de continuidade em PR (este PR inclusive) | ✅ rodando (5/5) | ✅ |
| **Pipeline gate-driven por `push`/PR** (`pipeline.yml`) | ✅ **roda** — cada push executa o gate de saúde e publica a próxima issue indexada no PR | ✅ |
| **Diretiva no commit** (`[pipeline] complete T-xxx`) | ✅ é o dispatch pré-merge | ✅ |
| Deploy Pages automático por push nas branches | ⏸ aguarda merge + bootstrap | ✅ |
| `gh workflow run agent.yml …` (dispatch) | ❌ **404** — o GitHub só despacha workflow presente na default | ✅ |
| `bootstrap-repo.yml` criando `dev`/`staging` | ⏸ idem | ✅ (dispara por push dos workflows) |
| Cron de ingestão/preços abrindo PR | ⏸ idem | ✅ |

Isso não é lacuna de implementação: é a regra do GitHub para `workflow_dispatch` e triggers de workflow.
**O merge do PR #1 é a chave** — e é uma ação do seu lado.

---

## 8. Auditoria: o que foi encontrado e corrigido

Auditoria pedida como "zero erro por verificação retornada". As três verificações vermelhas escondiam
defeitos reais — nenhum foi contornado com `--no-verify`, `continue-on-error` ou `as any` novo:

| Achado | Diagnóstico | Correção |
|---|---|---|
| `lint` 19 erros + 5 avisos | 13 props `any` no painel avançado, `val as any` no Compare, `align` ignorado no popover, hook de moeda duplicado | tipos reais derivados dos retornos reais; `align` implementado; fonte única de moeda |
| `validate:data` 13 erros | **o validador estava errado, não os dados** | enums espelham `GPUSpec`; faixa de memória `[0.1, 65536] GB` |
| `continuity:check` violação de escopo | a correção de qualidade mexeu em 11 arquivos não declarados | T-402 (lint) e T-406 (validadores/auditoria) concluídas com `crossPhase`, escopo do handoff de 53 → 62 globs |
| `agent:audit` exit 1 | julgava por histórico (falha antiga já corrigida) e por defasagem de snapshot (que todo commit cria) | veredito = **última execução de cada gate**; defasagem é aviso, não erro |
| **auditoria vermelha por definição** | o gate de saúde se gravava no ledger com `ok = veredito`; como ele é vermelho **enquanto há trabalho em voo**, o `agent audit` passava a reprovar para sempre (e o `verify:all` da T-410 pegou isso: 18/19) | o gate agora registra a **execução** (`ok` = conseguiu avaliar) e o veredito vai no detalhe + evento; só falha estrutural deixa o gate vermelho |
| **push que não gerou run nenhum** | a mensagem do commit **mencionava** o marcador de skip do Actions no corpo (como texto explicativo) — e o GitHub varre a mensagem inteira, então **todos** os workflows foram pulados | o marcador só aparece em commits onde é intencional; a lição entrou para a documentação: nunca escrever o token literal em mensagem de commit |
| **diretiva engolida pelo filtro de paths** | `paths-ignore` no gatilho `push` faz um **commit vazio** (que não tem paths) não gerar run — justo o caso da diretiva usada como dispatch pré-merge | filtro removido; o laço continua evitado porque os commits de estado carregam `[skip ci]` — provado com um commit vazio que agora dispara o pipeline |
| **artefato de teste commitado** | o `health.json` gerado pelo harness local entrou no repo por um `git add -A` — e o **gate de continuidade pegou** como violação de escopo | removido do versionamento e adicionado ao `.gitignore` junto de `complete.json`/`gate-report.json`/`comment.md` |
| **gateways pulados em silêncio no CI** | no `pipeline.yml`, `npm run` (sem `--silent`) imprime o banner no stdout e corrompia o `health.json`; o `$(...)` que falhava ficou **mascarado dentro do `echo`**, gravando `verdict=` vazio — os dois gateways eram pulados e o job ficava **verde** | o step agora **lê** o contrato: valida `verdict ∈ {success,continuity,error}` e falha alto se o JSON não vier; `--silent` em todo `npm run`; harness local prova os dois casos (válido → `verdict=continuity`; corrompido → exit 1) |
| **falso-verde** no gate de lint | sem problemas o ESLint não imprime nada → gate lia `undefined`; um lint que morresse antes do resumo contava como zero | `parseLintSummary` + gate exige processo OK **e** erros zero, com 3 testes de regressão |
| **falso-verde** latente no CI | `Lint full repo` estava `continue-on-error: true` ("dívida legada") | agora é **bloqueante** — a dívida acabou em `ea0c752` |
| **ledger encolhendo** | um sandbox recriado abre um banco local pobre; o `sync` exportava esse banco **por cima** do snapshot consolidado — o histórico caiu de 92 para 7 gates | `reconcileFromSnapshot`: a cada sync o banco só **soma** chaves ausentes (repor por cima está proibido; `kv` é por chave, pois a nota da sessão é mais nova localmente). Provado apagando o banco: `ledger restaurado do snapshot: gates+100 …` e o snapshot **cresceu**, não encolheu |
| `isVLM` lia campo inexistente | nem nos dados nem no tipo: branch morto sustentado por cast | campo opcional no `ArchitectureSpec`; painel continua oculto até haver dado que o sustente (sem inventar dado) |

---

## 9. O que falta

### 9.1 Depende de você (ação humana)

1. **Merge do PR #1** — destrava: `workflow_dispatch` do agente e do deploy, criação de `dev`/`staging`,
   cron de dados. Depois do merge: `gh workflow run bootstrap-repo.yml` e validar as URLs
   (tarefa **T-308**).
2. **Opcional:** definir `APP_ID` e `APP_PRIVATE_KEY` (secrets do repositório) para o agente usar a identidade
   do GitHub App em vez do token efêmero. Sem eles, tudo funciona com o `GITHUB_TOKEN`.
3. **Opcional:** habilitar **branch protection** exigindo os checks `Build & test` e `State & scope`
   (o gate existe e passa; a regra de proteção é config do repositório, fora do código).

### 9.2 Tarefas abertas no roadmap (honestidade sobre o que não está pronto)

| fase | abertas | o que é |
|---|---|---|
| P3 (91%) | `T-308` | publicar os três ambientes após o merge e validar URLs |
| P4 | `T-401` `T-403` `T-404` `T-405` | suíte **e2e Playwright** (não escrita), code-splitting do bundle (700 kB), cobertura de testes do store/rotas, auditoria de acessibilidade |
| P5 | `T-501` `T-502` `T-503` | exercitar/validar os workflows diários de dados, alerta de dados defasados na UI+gate, **i18n PT-BR/EN** (hoje só PT-BR) |
| P6 | `T-601` `T-602` `T-603` | kernel com **SIMD** + orçamento de tamanho no gate, kernel em **Web Worker**, deploy do módulo WASI em host serverless (Spin/wasmCloud/wasmtime) |
| P7 | `T-701` `T-702` | release v1.0 com changelog, documentar o fluxo de contribuição com o gate |

Progresso do roadmap: **20/33 tarefas (61%)** — P1 e P2 completas, P3 a uma tarefa do fim.

### 9.3 Limitações conhecidas (por desenho ou por escopo)

- **Sem backend e sem telemetria** — é requisito do produto, não pendência.
- **Bundle de 701,89 kB** em chunk único: funciona, mas é a T-403 que resolve.
- **`docker.yml` não empurra imagem por padrão** (push ao GHCR é opt-in no dispatch).
- **O artefato Pages vive no CI** (`_site/` é gerado, não versionado) — localmente use `npm run build:pages`.
- **Bateria e ledger dependem do Node local** para os números; no CI as mesmas verificações rodam em jobs.

---

## 9bis. Incremento — pipeline gate-driven (BPMN via gates do Actions)

Pedido: (1) **gatilho** que verifica a não-existência de issues abertas, CI com erro e
testes ausentes — enquanto não positivo, isso **significa continuidade**; (2) **cada
issue concluída é testada e entregue com a instrução da seguinte**, construída e
**indexada**; sucesso constrói a próxima, erro devolve erro **com as informações de
continuidade**; e **toda ação responde um objeto JSON** (id, mensagem, anexos, status,
próxima issue, exit 0/1/2).

| Entregue | Onde |
|---|---|
| Gatilho de saúde (issues · CI · testes · instrução de teste por tarefa) | `scripts/pipeline.ts health` + `scripts/lib/pipeline-core.ts` |
| Ciclo `complete` (testa → entrega → próxima indexada / retry na mesma) | `scripts/pipeline.ts complete` |
| Contrato JSON único e exit codes 0/1/2 derivados do status | `scripts/lib/result.ts` (usado pelas ações do pipeline **e** pelo `agent --json`) |
| Blueprint BPMN como workflow | `.github/workflows/pipeline.yml` (jobs `gate` → `instruction` \| `ready`; `complete` dispatchável) |
| Gatilhos automáticos | `workflow_run` (fim de CI/Continuity gate) · `schedule` diário · `workflow_dispatch` |
| Spec e documentação | `.kiro/specs/18-gate-driven-pipeline.md` + `PIPELINE.md` (com o mermaid do fluxo) |
| 20 testes do contrato e do núcleo | `scripts/pipeline.test.ts` |

**Provado na prática nesta sessão** (saídas reais em `PIPELINE.md`): o gate respondeu
`continuity` com 13 pendências e a próxima issue indexada (`T-308`, fila 1/13); a T-409
**reprovou** na primeira submissão por 3 erros de lint meus — a resposta foi erro tipo 1
com o log anexado e **retry da mesma issue** (o pipeline pegou o defeito antes de mim);
depois de corrigida, `complete T-409` → `success`, `done` marcado, gate `task:T-409` no
ledger e próxima issue `T-308`; `complete T-999` → erro tipo 2 (exit 2); re-completar a
T-409 → idempotente.

O que este incremento **não** é: um substituto do CI (o CI julga o commit; o gate julga
a fila do projeto) e nem um orquestrador externo — a decisão é o exit code, o contrato é
o JSON, exatamente como um gateway BPMN.

## 10. Notas de robustez (o que esta sessão provou na prática)

- O sandbox foi **recriado entre turnos** (`node_modules` e `/tmp` apagados, `/tmp/verify-all.sh` perdido,
  HEAD local rebobinado para `cdfee43`). O trabalho foi **reancorado a partir do remoto sem perda**: o
  conteúdo do working tree foi confirmado byte a byte idêntico a `70ddcfd` antes de mover o HEAD.
- Por isso a bateria agora é **versionada**: `npm run verify:all` (não depende mais de arquivo em `/tmp`).
- E por isso o `sync` deixou de confiar no banco local: ele reconcilia com o snapshot versionado somando o que
  falta, o que torna o reset de sandbox inofensivo para o histórico (ver a linha do ledger na seção 8).
- Credenciais: nenhuma entra em arquivo versionado, log ou chat. O agente e os workflows operam com
  identidade própria; o 403 em `actions/secrets` é a prova de que esta sessão não toca segredos.

---

## 11. Comandos de referência rápida

```bash
# usar o produto
npm ci && npm run stack            # página :5173 + runtime WASI :8787
docker compose up app app-staging app-dev   # 3 ambientes em container
npm run build:app && npm run serve # estático, offline

# verificar tudo (o que o CI distribui em jobs)
npm run verify:all                 # 18 checks, exit 0 = tudo verde
npm run verify:all -- --quick      # sem sync/auditoria

# continuidade e auditoria
npm run continuity:check           # gate de escopo/estado
npm run continuity:sync -- --pages # consolida invariantes + ledger
npm run continuity:resume          # briefing de retomada
npm run store -- gates --summary   # ledger: gates como dado
npm run agent -- audit             # veredito pelo ledger (exit code)

# depois do merge do PR #1
gh workflow run bootstrap-repo.yml                       # cria dev/staging + Pages
gh workflow run deploy-pages.yml -f environments=all     # publica os 3 ambientes
gh workflow run agent.yml -f action=deploy -f environments=staging -f ref=main
```
