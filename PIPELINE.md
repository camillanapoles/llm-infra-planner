# Pipeline gate-driven — o fluxo issue → teste → próxima issue

> Spec: [`.kiro/specs/18-gate-driven-pipeline.md`](.kiro/specs/18-gate-driven-pipeline.md) · Código: `scripts/pipeline.ts`, `scripts/lib/{result,pipeline-core}.ts` · Gates: [`.github/workflows/pipeline.yml`](.github/workflows/pipeline.yml)
> Tudo aqui foi executado e está nos commits — os trechos de saída abaixo são reais, não ilustrativos.

---

## 1. O blueprint (BPMN) como gates do GitHub Actions

```mermaid
flowchart TD
  A([push / PR / cron / dispatch]) --> B[GATE: health]
  B -->|exit 0 · positivo| R([READY · pronto para release])
  B -->|exit 1 · não positivo| C[CONSTRUI a próxima issue indexada]
  B -->|exit 2 · estrutural| X([✖ PARA · consertar o fluxo])
  C --> D[TESTA: verify da issue]
  D -->|passou| E[ENTREGA: done + gate no ledger + próxima issue]
  E --> B
  D -->|reprovou| F[ERRO TIPO 1 · log anexado · MESMA issue volta] --> B
```

Cada nó é um job/step do workflow; a transição é o **exit code** (o gate), e a
carga entre nós é o **objeto JSON** (o contrato). É gate-driven literalmente:
não há um orquestrador externo decidindo — a decisão está no código de saída.

| Elemento BPMN | Implementação |
|---|---|
| Evento de início | `push`/PR → CI conclui → `workflow_run`; `schedule` diário 07:23 UTC; `workflow_dispatch` |
| Tarefa (gate) | job `gate` → `pipeline health` (issues · CI · testes) |
| Gateway exclusivo | `exit 0` → job `ready`; `exit 1` → job `instruction`; `exit 2` → job vermelho |
| Tarefa de trabalho | job `complete` (dispatch, `stage=complete`) → `pipeline complete T-xxx` |
| Mensagem/artefato | JSON + `next-<id>.md` + `logs/<T>-verify.log` (upload como artifact; commit no `main`) |
| Evento de fim | job `ready` (positivo) ou job vermelho (tipo 2) |

---

## 2. O gatilho de saúde

```bash
npm run pipeline -- health          # JSON no stdout; exit 0/1/2
npm run pipeline -- health --text --emit --record   # resumo, anexos, gate no ledger
```

Verifica a **não-existência** de três coisas — e enquanto qualquer uma existir, o
veredito é `continuity`:

| Verificação | Positivo quando | Fonte |
|---|---|---|
| Issues abertas | nenhuma | GitHub Issues (se habilitado) **ou** as tarefas abertas do roadmap |
| CI com erro | nenhuma execução concluída com `failure`/`timed_out`/`action_required` | `gh run list` da branch |
| Testes | existem arquivos e passam | `npm test` |
| Instrução de teste | toda tarefa aberta tem `verify` | roadmap |

> **Issues desabilitadas neste repositório** (conferido: `has_issues = false`), então os
> work items vêm do roadmap indexado (`T-xxx`). O código consulta `hasIssuesEnabled`
> primeiro: habilitar Issues no GitHub troca a fonte **sem mudar código**.
> Execuções em andamento **não** bloqueiam — um gate que espera o próprio run nunca fecharia.

### Saída real (este repositório, hoje)

```json
{
  "id": "health@2026-10-13T14:31:30.265Z",
  "action": "health",
  "status": "continuity",
  "message": "não positivo — continuação: 13 item(ns) aberto(s) em roadmap: T-308, T-401, T-403 …",
  "attachments": [],
  "nextIssue": { "id": "T-308", "index": 16, "queuePosition": 1, "queueTotal": 13,
                 "verify": "gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml",
                 "acceptance": "`gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` retorna 0",
                 "actionable": true, "reason": "next" },
  "exitCode": 1
}
```

---

## 3. O contrato: toda ação responde o mesmo objeto

| Campo | Tipo | Papel |
|---|---|---|
| `id` | string | `<ação>@<ISO>` — identifica a execução e nomeia o artefato |
| `action` | string | qual ação rodou (`health`, `next`, `complete T-xxx`) |
| `status` | string | `success` · `continuity` · `error` |
| `errorType` | number? | só em erro: **1** = reprovou (tente de novo) · **2** = estrutural (pare) |
| `message` | string | frase legível; pode vir vazia, pode trazer o log |
| `attachments` | array | **anexos gerados**: `path`, `filename`, `kind`, `bytes` |
| `nextIssue` | objeto? | a seguinte (indexada) em sucesso; a **mesma** (`reason: retry`) em falha |
| `exitCode` | 0/1/2 | é o que o shell e o Actions enxergam — **derivado** do status |
| `at`, `actor` | string | quando e quem (no CI, o ator do GitHub) |
| `details` | objeto | evidências específicas da ação (checks, log tail, continuidade) |

```bash
# o JSON é o contrato e vai sempre no stdout
npm run pipeline -- health > health.json
# resumo legível no stderr + gravação no resumo do Actions
npm run pipeline -- next --text --summary --emit
```

Quem responde este objeto: as três ações do pipeline (`health`, `next`, `complete`) e
**também o agente** quando chamado com `--json` (`npm run agent -- audit --json` devolve o
envelope com `details.payload` — a auditoria completa — e a cabeça da fila em `nextIssue`).

**Exit codes** — 0 sucesso · 1 **erro tipo 1** (verificação reprovou / gate não
positivo: continuidade, com o log e o ponto de retomada) · 2 **erro tipo 2**
(estrutural: entrada inválida, tarefa inexistente, sem instrução de teste,
roadmap ilegível). `exitCode` nunca é digitado à mão: sai de `status`+`errorType`,
então um JSON não consegue dizer `success` com exit não-zero.

---

## 4. O ciclo: cada issue concluída é testada e entregue com a SEGUINTE

```bash
npm run pipeline -- complete T-409          # roda o verify, decide, responde
```

```mermaid
stateDiagram-v2
  [*] --> Testa
  Testa --> Entrega: verify → 0
  Testa --> Tipo1: verify ≠ 0
  Entrega --> [*]: done + gate no ledger + próxima issue indexada
  Tipo1 --> [*]: log anexado + continuidade + MESMA issue (retry)
```

### 4.1 Sucesso — saída real

```json
{
  "action": "complete T-409",
  "status": "success",
  "message": "T-409 testada e entregue (`npm test && npm run lint` → 0) — próxima issue: T-308",
  "attachments": [
    { "path": ".kiro/state/pipeline/logs/T-409-verify.log", "kind": "log", "bytes": 2140 },
    { "path": ".kiro/state/pipeline/next-T-308.md", "filename": "next-T-308.md", "kind": "md" }
  ],
  "nextIssue": { "id": "T-308", "index": 16, "queuePosition": 1, "queueTotal": 13, "reason": "next" },
  "exitCode": 0
}
```

O que ele fez nesse caminho: rodou o `verify` do roadmap → marcou a tarefa `done`
(com evidência) → gravou `task:T-409` como gate **e** um evento no ledger de
continuidade → anexou o log e o briefing da próxima issue.

### 4.2 Falha de verificação — erro tipo 1 (real, pego pelo próprio pipeline)

Quando a T-409 foi submetida antes de eu corrigir 3 erros de lint no meu próprio
arquivo, a resposta foi:

```
status: error | errorType: 1 | exitCode: 1
message: T-401 reprovada no teste de aceite `npm run test:e2e` (exit 1) — log em .kiro/state/pipeline/logs/T-401-verify.log
attachments: [('.kiro/state/pipeline/logs/T-401-verify.log', 4072)]
nextIssue: T-401 (reason: retry)
continuity: source=snapshot | retomada: "Entrega do kernel WebAssembly + runtime WASI + deploy em 3 ambientes…"
            bloqueios: ["T-308 depende do merge do PR #1"] | lastSync: 3b20e12 (63%)
```

### 4.3 Estrutural — erro tipo 2 (real)

```
$ npm run pipeline -- complete T-999     → exit 2
status: error | errorType: 2 | message: "T-999 não existe no roadmap"
details.known: ["T-101", "T-102", …]
```

### 4.4 Idempotência (real)

```
$ npm run pipeline -- complete T-409     → exit 0
message: "T-409 já estava concluída — nada a fazer" | nextIssue: T-308
```

---

## 5. Como usar

```bash
# o gatilho (local ou CI)
npm run pipeline -- health --text --emit --record

# a fila, como JSON
npm run pipeline -- tasks

# construir a próxima issue indexada (head da fila, ou a sucessora de outra)
npm run pipeline -- next --emit
npm run pipeline -- next --from T-402 --emit

# concluir: testa, entrega e devolve a próxima
npm run pipeline -- complete T-403 --emit --text
```

No GitHub Actions: **Actions → Pipeline (gate-driven) → Run workflow**
(`stage = health | next | complete`, com `task = T-xxx` no último caso).

---

## 6. Integrações que fazem o fluxo fechar

| Peça | Papel no fluxo |
|---|---|
| `.kiro/state/roadmap.json` | a fila indexada: id, título, fase, escopo, `verify` (o teste de aceite) |
| `.kiro/state/pipeline/**` | artefatos versionados: `health.json`, `next-<id>.md`, `logs/<T>-verify.log` |
| Ledger (`continuity.db` + snapshot) | cada `complete` grava `task:<T-xxx>` como gate e um evento — a auditoria enxerga o fluxo |
| `continuity-check` | o gate de escopo continua valendo: a entrega só passa se o diff respeitar os `paths` da tarefa |
| `npm run verify:all` | inclui `pipeline:cli` (o contrato responde) além dos 18 checks de código/estado |
| `workflow_run` | o gatilho roda **sozinho** ao fim de CI/Continuity gate — ninguém precisa lembrar de conferir |

---

## 7. Como o progresso continua — gatilhos, GitHub App e OAuth

### 7.1 A matriz: o que já roda hoje e o que depende do merge

Nem todo gatilho do Actions funciona em branch que não é a default. A divisão é
exata (e está comentada no topo do workflow):

| Gatilho | Pré-merge (esta branch) | Pós-merge (default) | Para que serve |
|---|---|---|---|
| `push` | ✅ roda | ✅ | **é o dispatch de hoje**: cada push roda o gate de saúde |
| `pull_request` | ✅ roda | ✅ | veredito por PR, sem precisar de label |
| `workflow_call` | ✅ roda | ✅ | outro workflow encadeia o gate (`ci.yml`, `continuity-gate.yml`…) |
| `workflow_dispatch` | ❌ 404 | ✅ | dispatch manual/por API |
| `schedule` (cron) | ❌ | ✅ | heartbeat diário (07:23 UTC) |
| `workflow_run` | ❌ | ✅ | roda sozinho ao fim de CI/Continuity gate |
| `repository_dispatch` | ❌ | ✅ | eventos externos |

**Enquanto não houver merge, o dispatch é um `git push`** — e a rota aceita uma
diretiva ancorada no início da linha da mensagem do commit, escolhendo a tarefa do
blueprint sem precisar de `workflow_dispatch`:

```bash
git commit --allow-empty -m "[pipeline] complete T-401"   # testa + entrega + próxima
git commit --allow-empty -m "[pipeline] next"             # reconstrói a instrução
git push
```

A rota é endurecida de propósito: a diretiva só vale **no começo de uma linha** e a
tarefa só entra no formato `T-123`. Assim um exemplo citado no corpo do commit
(“…use a diretiva…” ) **não** vira rota, e `[pipeline] complete 123` falha com erro
tipo 2 em vez de adivinhar.

Duas armadilhas do Actions ficaram registradas (cada uma custou um run para aparecer,
e as duas foram corrigidas no próprio workflow):

- **filtro de paths**: `paths-ignore` no gatilho `push` engole o commit **vazio** — que
  não tem path nenhum para casar. O filtro saiu de cena; o laço continua evitado pelo
  caminho certo, o marcador de skip nos commits de estado.
- **marcador de skip no texto**: o GitHub varre a mensagem **inteira** (assunto *e* corpo)
  atrás do token que pula workflows. **Citar** o token numa frase explicativa pula
  **todos** os workflows daquele push — foi o que aconteceu num commit desta sessão: o
  commit estava no remoto e nenhum run foi criado. A regra prática: o token de skip só
  aparece em commit onde pular é a intenção.

### 7.2 O laço: quem reinicia o ciclo

```
   push/PR ──▶ gate de saúde ──▶ não positivo ──▶ instrução da próxima issue ──▶ (executa) ──▶ push/PR ──▶ …
                     │
                     └─ positivo ──▶ READY (o produto está pronto para release)
```

Detalhe que decide a arquitetura: **push feito com o `GITHUB_TOKEN` do runner NÃO
dispara outros workflows** (é o que impede recursão infinita). Ou seja:

- **Sem App** (hoje): o laço é reiniciado por (a) push/PR de quem trabalha, (b) cron
  diário no main (pós-merge), (c) dispatch manual/por API. Os commits de estado do
  próprio pipeline usam `[skip ci]` e não criam tempestade.
- **Com App**: o push do bot passa a **disparar** CI e pipeline — o ciclo passa a se
  auto-alimentar sem ninguém empurrar. É a diferença entre "automação que roda quando
  alguém mexe" e "automação que continua sozinha".

### 7.3 GitHub App × OAuth — qual identidade para continuar o progresso

| | **GitHub App** (recomendado) | **OAuth App** | `GITHUB_TOKEN` (hoje) |
|---|---|---|---|
| Identidade | bot do App (não é pessoa) | **você** (age como usuário) | o próprio run |
| Token | instalação, ~1 h, por run | do usuário + refresh | efêmero, morre no fim do run |
| Escopo | fino, por permissão | amplo (`repo`, `workflow`…) | do repositório |
| Sobrevive à saída da pessoa? | ✅ (instalação) | ❌ (morre com o usuário) | n/a |
| Dispara workflows a partir de push | ✅ | ✅ | ❌ |
| Serve para | **automação de CI/CD** | login interativo de terceiros | o ciclo dentro de um run |

OAuth existe para *delegar a identidade de uma pessoa* a uma aplicação interativa —
o oposto do que se quer num bot: mistura identidade humana com automação, expira com
a pessoa e exige escopos largos. Para continuidade, o primitivo certo é **App**.

### 7.4 Como habilitar a App (passo a passo, do lado do dono do repo)

1. `github.com/settings/apps` → **New GitHub App** (owner: sua conta/org).
2. Webhook: **desmarcar** (não precisamos; quem reage é o Actions).
3. Permissões do repositório: **Contents** `Read and write` (commits/branches) ·
   **Actions** `Read and write` (dispatch) · **Pull requests** `Read and write`
   (comentar/abrir PR) · **Issues** `Read and write` · **Metadata** `Read-only` (obrigatória).
4. “Where can this App be installed”: **Only on this account** → Create → anote o
   **App ID** → **Generate a private key** (`.pem`).
5. **Install App** → selecione este repositório.
6. No repositório: *Settings → Secrets and variables → Actions* → **New secret**
   `APP_ID` (número) e `APP_PRIVATE_KEY` (o `.pem` inteiro).
7. Nada mais muda: o workflow `agent.yml` já chama `actions/create-github-app-token`
   quando `APP_ID` existe e cai para o `GITHUB_TOKEN` quando não existe.

> A chave privada vive **só no cofre do Actions**. Este repositório, o ledger e o
> agente nunca a leem, e ela não entra em chat, arquivo versionado ou log. (Um PAT
> resolveria parecido, mas com identidade pessoal e escopo amplo — por isso é
> recusado aqui: nenhuma credencial pessoal, em lugar nenhum.)

### 7.5 O que a App destrava, concretamente

| Capacidade | Sem App | Com App |
|---|---|---|
| Rodar o gate a cada push/PR | ✅ | ✅ |
| Comentar a próxima issue no PR | ✅ | ✅ |
| Dispatch manual (`workflow run`) | só pós-merge | pós-merge |
| Push do bot dispara CI/pipeline | ❌ | ✅ **fecha o laço** |
| Identidade estável do bot nos commits/comentários | `github-actions[bot]` | `<app>[bot]`, com permissões declaradas |
| Auditoria de quem agiu | ator do run | instalação do App, por run |

## 8. Limites e decisões (para não vender o que não é)

- **Issues do GitHub desabilitadas** → a fila é o roadmap. Habilitar troca a fonte
  automaticamente; a leitura usa `hasIssuesEnabled`.
- **`workflow_run`/`dispatch`/`schedule` só funcionam com o workflow na branch default** —
  por isso o `push`/`pull_request`/`workflow_call` existem: são o caminho que funciona **agora**
  (ver §7.1). Nada aqui está esperando o merge para rodar; só o *dispatch por API* espera.
- **Execuções em andamento não bloqueiam** o gate (senão ele esperaria a si mesmo).
- **O gate de saúde não substitui o CI**: ele responde "o projeto está pronto?" e o
  CI responde "este código está correto?". Um dá o veredito do produto, o outro do commit.
- **`--tests=skip` existe para inspeção rápida** e, por definição, nunca resulta em positivo
  (fonte de teste indisponível é bloqueio — a regra é "enquanto não positivo, continuidade").
