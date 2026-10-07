# SPEC 17: Continuity gate (state-driven scope & resume)

## Description

Branches created after a merge must (a) stay inside the project's scope and (b) continue from the exact point where the previous work stopped. This spec turns that into a **machine-checked contract**:

```
.kiro/state/roadmap.json   fases → tarefas → { status, paths, verify, dependsOn }   ← fonte de escopo
.kiro/state/policy.json    regras do gate (shared/kernel/state paths, specs, labels) ← fonte de regra
.kiro/state/branches/*.json  handoff: o que ESTA branch se compromete a entregar
.kiro/state/project-state.json + STATE.md + RESUME.md + public/state.json           ← estado derivado
```

The gate (`scripts/continuity.ts check`) is run locally and **blocks every PR** via
`.github/workflows/continuity-gate.yml`. After merges, `continuity-sync.yml`
measures objective invariants and writes the state that the next session resumes from.

## Requirements

### Requirement 1: Project state is explicit and machine-readable
**User Story:** As a maintainer, I want the project's scope and progress to live in the repo — not in someone's head — so any session can pick it up.

**Acceptance Criteria:**
- `roadmap.json` describes phases (with `exitCriteria`) and tasks with `id`, `title`, `status`, `paths` (escopo), `verify` (aceite), `dependsOn`, optional `spec`, `evidence`.
- `policy.json` declares `baseBranch`, `protectedBranches`, `statePaths`, `sharedPaths`, `kernelPaths`, `scopes` (spec → paths) e o nome da label de bypass.
- `validateRoadmap()` rejeita: ids duplicados, status inválido, dependência inexistente, auto-dependência; e avisa `done` sem `evidence`.
- Roadmap validation and phase rules are unit-tested (`scripts/continuity.test.ts`, 37 testes).

### Requirement 2: Every branch declares what it delivers (handoff)
**User Story:** As a reviewer, I want each branch to state its scope and resume point before I review the code.

**Acceptance Criteria:**
- `npm run continuity:start [--task T-xxx] [--spec id] [--auto]` cria/atualiza `.kiro/state/branches/<slug>.json` com `scope {specs,tasks,paths}` e `resumePoint {summary,next,blockedBy}` e um `history` append-only.
- `--auto` infere o escopo pelo nome da branch em camadas (ver Requirement 8) e nunca cria um handoff vazio que reprovaria a própria branch.
- O gate **cria o handoff automaticamente** no primeiro push de um PR que não o tenha e o commita na branch do PR (nunca em forks), então a adoção é sem atrito.
- Um handoff sem escopo ou sem `resumePoint.summary` é erro: a próxima sessão precisa saber onde parou.

### Requirement 3: Scope is enforced against the real diff
**User Story:** As a maintainer, I want to be warned — at PR time — when a branch drifts outside its declared scope.

**Acceptance Criteria:**
- Escopo efetivo = `handoff.scope.paths` ∪ `policy.scopes[spec]` ∪ `roadmap task.paths` das tarefas declaradas.
- Classificação de cada arquivo alterado: `state` (`.kiro/state/**`, `public/state.json`), `inScope`, `shared` (`package.json`, `README.md`, `eslint.config.js`, workflows do próprio gate…) e `outOfScope`.
- Qualquer `outOfScope` **reprova** o gate, com os caminhos ofensivos e a instrução de correção; a label `scope:allow` rebaixa para aviso e exige atualização do handoff/roadmap (expansão intencional e registrada).
- Glob matching próprio (`**` cruza diretórios, `*`/`?` dentro do segmento, `dir/**` cobre o próprio diretório) — coberto por testes.
- O diff é calculado contra o merge-base da branch base (`--base`), e `--files a,b` permite checagem determinística em CI.

### Requirement 4: The resume point survives the branch
**User Story:** As the next developer (or agent), I want one command that tells me where to continue, with the constraints, without reading the whole history.

**Acceptance Criteria:**
- `npm run continuity:resume` escreve/imprime `RESUME.md` com: fase atual + % do roadmap, escopo e próximos passos do handoff, **próximas tarefas com bloqueios e comando de aceite**, últimos commits, guardrails e comandos de retomada.
- `npm run continuity:status` mostra barras de progresso por fase e as próximas tarefas, mais as branches com escopo declarado.
- `computeNextTasks()` lista tarefas abertas em ordem de roadmap, marcando `blockedBy` quando uma dependência não está `done` (nunca esconde bloqueio).
- O gate publica este briefing como **comentário idempotente no PR** (substitui o anterior), então o ponto de parada fica visível na revisão.

### Requirement 5: Objective invariants are measured, not asserted
**User Story:** As a maintainer, I want the state to record what was actually verified, at which commit.

**Acceptance Criteria:**
- `npm run continuity:sync` executa e registra: `wasm:verify` (contagem de verificações), validação estática do docker, `npm test` (testes/arquivos), `npm run build` (ok + kB do chunk principal), `npm run lint` (erros/avisos) e, com `--pages`, os 3 ambientes do artefato de Pages; `--fast` pula os caros.
- O estado grava `headSha` + `generatedAt` — a procedência do que foi medido.
- `public/state.json` é publicado junto com a página (fase, progresso, próximas tarefas, invariantes) para a UI.
- `continuity-sync.yml` roda em **push para `main`** e semanalmente, commitando o estado: direto se a `main` permitir, senão em um PR `chore/continuity-state-*` com auto-merge.

### Requirement 6: Kernel changes are re-verified, phase order is respected
**User Story:** As a maintainer, I want the wasm/TS parity and phase discipline to be structural, not conventions.

**Acceptance Criteria:**
- `kernelPaths` (`wasm/**`, `src/lib/formulas/**`, `src/wasm/**`): se o diff altera o núcleo **depois** do último `sync`, o gate reprova com `kernel-stale-state` — é a prova de que a mudança foi revalidada (rebuild + wasm:verify + paridade).
- Quando o núcleo é tocado, o workflow roda `build:wasm` + `wasm:verify` + `vitest src/wasm/kernel.test.ts` e falha o PR se divergir.
- `checkPhaseDiscipline()` avisa quando uma tarefa de fase posterior avança enquanto uma fase anterior tem pendências, com escape explícito `"crossPhase": true`.
- Tasks concluídas exigem `evidence` (aviso), e um handoff `done` com tarefa ainda aberta no roadmap é erro (`roadmap-not-updated`).

### Requirement 7: Bootstrap and deploys stay aligned with the state
**User Story:** As the repo owner, I want the automation that creates branches/deploys to also carry the continuity state.

**Acceptance Criteria:**
- `bootstrap-repo.yml` cria `dev`/`staging` a partir do commit que já contém o estado consolidado (o estado viaja com o código).
- O gate roda em PRs contra `main`, `dev` e `staging`, com `protectedBranches` dispensando o requisito de handoff (branches de integração não são "trabalho novo").
- `ci.yml` roda o check de continuidade de forma informativa em cada push, mantendo o bloqueio no workflow dedicado.
- `ci.yml` valida os próprios arquivos de workflow (`npm run validate:workflows`) — chave YAML duplicada faz o GitHub rejeitar o arquivo inteiro com falha em 0s, sem log.

### Requirement 8: A new branch bootstraps its own scope from the roadmap
**User Story:** As the next developer (or agent), I want to create a branch after a merge and have it start already aligned with the project and positioned exactly where the work stopped — without anyone narrating it.

**Acceptance Criteria:**
- `inferScope(branch, roadmap, policy)` (pure, in `continuity-core.ts`) resolves in tiers, from the most specific to the least:
  1. `explicit` — task id in any spelling (`t-401`, `t401`, `401`), a word of the task title (accents ignored) or a spec slug/word (`13-deploy-github-pages`, `wasi-runtime`); declaring a spec also declares the open tasks it owes the roadmap;
  2. `resume-point` — nothing matched: the branch inherits the **first open task whose dependencies are satisfied** (the same task `RESUME.md` shows as next), with its paths, spec and acceptance command, so "continue from where it stopped" is the default rather than an error;
  3. `promotion` — `main`/`dev`/`staging` carry whole-tree merges: file scope is not applicable and the gate reports `promotion-branch` (info) instead of validating a diff that is the entire history;
  4. `none` — nothing matched and the roadmap has no open task: the branch must declare scope explicitly.
- The handoff records **why** the scope was chosen (`history[].note`) and the CLI prints it (`↳ escopo reconhecido…`, `↬ escopo herdado do ponto de retomada…`), so the inference is auditable, never silent.
- Every tier is unit-tested, including: numbers that are not task ids falling back to the resume point, blocked-first-task resolution, accented titles, and environment branches.
- `npm run continuity:start -- --auto` on an environment branch creates no handoff (there is nothing to scope).

## Usage

```bash
npm run continuity:status                       # onde estamos
npm run continuity:start -- --task T-402        # declara o escopo desta branch
npm run continuity:check                        # gate local (o mesmo do CI)
npm run continuity:check -- --json              # relatório para máquinas
npm run continuity:sync                         # mede invariantes e atualiza o estado
npm run continuity:sync -- --fast --pages       # só o barato + artefato de Pages
npm run continuity:resume                       # briefing de retomada
```

## Files

```
.kiro/state/roadmap.json            fases, tarefas, escopo, dependências (fonte)
.kiro/state/policy.json             regras do gate, specs, paths compartilhados
.kiro/state/branches/<slug>.json    handoff por branch (auto-criado pelo CI)
.kiro/state/project-state.json      estado derivado + invariantes + gates
.kiro/state/STATE.md / RESUME.md    visões legíveis (geradas)
public/state.json                   estado publicado com a página
scripts/lib/continuity-core.ts      lógica pura (validação, escopo, progresso, render)
scripts/continuity.ts               CLI: status · check · start · sync · resume
scripts/continuity.test.ts          37 testes do núcleo do gate
scripts/validate-workflows.py       detecta chave duplicada em workflow (falha silenciosa do GitHub)
.github/workflows/continuity-gate.yml   gate bloqueante em PRs + comentário de retomada
.github/workflows/continuity-sync.yml   consolidação do estado na main
CONTINUITY.md                       porta de entrada para humanos
```
