# Continuidade do projeto

> Este repositório é **state-driven**: o escopo e o progresso do projeto vivem em
> `.kiro/state/`, e um gate de CI garante que cada branch continue de onde a
> anterior parou — sem sair do escopo.

**Ponto de retomada agora:** [`.kiro/state/RESUME.md`](.kiro/state/RESUME.md) · **estado do roadmap:** [`.kiro/state/STATE.md`](.kiro/state/STATE.md)

---

## Como o estado funciona

```
.kiro/state/
├── roadmap.json          ← fases, tarefas, dependências, escopo por caminho (FONTE)
├── policy.json           ← regras do gate: shared paths, kernel paths, specs
├── project-state.json    ← estado DERIVADO (gerado por continuity:sync)
├── STATE.md              ← estado legível (gerado)
├── RESUME.md             ← briefing de retomada (gerado)
└── branches/<slug>.json  ← handoff: o que ESTA branch entrega
```

Nada de estado é escrito à mão duas vezes: `roadmap.json` e `policy.json` são a
fonte; `project-state.json`, `STATE.md`, `RESUME.md` e `public/state.json` são
gerados por `npm run continuity:sync`.

## Ciclo de trabalho (do zero ao merge)

```bash
npm ci

# 1. situar-se: onde paramos e o que vem agora
npm run continuity:status

# 2. declarar o escopo desta branch (cria .kiro/state/branches/<slug>.json)
npm run continuity:start -- --task T-402
#    ou deixar o nome da branch falar por si:
npm run continuity:start -- --auto
#    --auto: t-401/t401/401 ou palavra do título → escopo exato da tarefa
#             spec (13-deploy-github-pages, wasi-runtime) → escopo do spec
#             nada reconhecido → herda o ponto de retomada (primeira tarefa aberta)

# 3. trabalhar… e então validar localmente com o MESMO gate do CI
npm run lint:changed      # passo bloqueante do CI (só arquivos alterados)
npm run continuity:check

# 4. medir invariantes e atualizar o estado (tests/build/lint/wasm/docker)
npm run continuity:sync

# 5. commitar código + estado juntos (o gate exige essa coerência)
git add -A && git commit -m "feat: ..."
```

## O que o gate reprova

| código | significado | como resolver |
|---|---|---|
| `missing-handoff` | a branch não declarou escopo | `npm run continuity:start -- --task T-xxx` (o workflow cria automaticamente no primeiro push do PR) |
| `scope-violation` | o diff toca arquivos fora do escopo | declare a tarefa/caminho no handoff, ou use a label **`scope:allow`** para expansão intencional |
| `handoff-unknown-task` | a tarefa citada não existe no roadmap | corrija o id ou adicione a tarefa em `roadmap.json` |
| `roadmap-not-updated` | handoff diz `done`, roadmap diz `in_progress` | atualize `roadmap.json` (status + `evidence`) |
| `kernel-stale-state` | o núcleo foi alterado depois do último sync | `npm run continuity:sync` e commit do estado — prova que a mudança foi revalidada |
| `phase-out-of-order` | tarefa de fase posterior adiantada | conclua a fase aberta ou marque `"crossPhase": true` |
| `done-without-evidence` | tarefa concluída sem evidência | preencha `evidence` com o artefato que comprova |
| `stale-state` | estado muito atrás do HEAD | `npm run continuity:sync` |
| `promotion-branch` *(info)* | `main`/`dev`/`staging` carregam merge de árvore inteira | nada a fazer — o escopo é cobrado nas branches de trabalho |

O gate roda em **todo PR** contra `main`/`dev`/`staging`
(`.github/workflows/continuity-gate.yml`) e publica um comentário com o
**ponto de retomada** + o roadmap. Merges na `main` consolidam o estado
(`.github/workflows/continuity-sync.yml`).

## O JSON de acesso (`.kiro/state/access.json`)

É o primeiro arquivo que uma sessão nova deve ler — o briefing em formato de máquina.
Gerado por `npm run continuity:sync`, versionado, **sem nenhum segredo** (a autenticação vem
do ambiente: `gh auth`), validado por `npm run validate:access` em todo PR e servido pelo
runtime WebAssembly em `/api/access`:

```jsonc
{
  "coordinates": { "repo": "camillanapoles/llm-infra-planner", "pullRequest": { "number": 1, "url": "…" },
                   "branches": { "working": "arena/…", "default": "main", "environments": ["dev", "staging"] } },
  "runtime":     { "local": { "page": "http://localhost:5173", "wasi": "http://localhost:8787" },
                   "artifact": { "build": "node scripts/build-pages-artifact.mjs …", "verify": "bash scripts/verify-pages-artifact.sh _site" } },
  "deploy":      { "environments": { "main": { "url": "https://camillanapoles.github.io/llm-infra-planner/" }, … },
                   "automatic": { "trigger": "push em main/dev/staging" } },
  "continuity":  { "readOrder": ["…access.json", "…RESUME.md", "…STATE.md", "CONTINUITY.md"],
                   "resumeCommands": ["git fetch origin && git reset --hard origin/<branch>", "npm ci", "npm run build:wasm", …],
                   "nextTasks": [ { "id": "T-308", "blockedBy": ["merge do PR #1"] } ] },
  "validation":  { "command": "npm run validate:access" }
}
```

O validador morde: token vazado, campo de credencial, comando/arquivo/workflow inexistente,
tarefa fora do roadmap e URL de outro site **reprovam**; descriptor atrás do HEAD **avisa**.
Leia com `npm run continuity:access` (resumo) ou `--json` (cru).

## O ledger (`.kiro/state/store.json` + `.db` local)

Estado declarado (`roadmap.json`) vs **estado vivido**: o ledger guarda o que
aconteceu — sessões, eventos, execuções de gate, notas que a sessão setou e os
espelhos consultáveis de tarefas/handoffs. SQLite local (`node:sqlite`), com
fallback JSON; o snapshot `.json` é o que viaja no git.

```bash
npm run store -- set objetivo_do_dia "merge + publicar dev/staging"   # seta
npm run store -- get objetivo_do_dia                                  # recupera (JSON-aware)
npm run store -- query gates --where 'ok=false' --order ran_at:desc   # pergunta
npm run store -- gate wasm-verify --ok true --detail "16/16"          # gate como dado
npm run store -- session start --goal "…"                             # onde estou
npm run store -- events                                               # o que aconteceu
npm run store -- export                                               # snapshot p/ o git e /api/store
```

| coleção | o que guarda |
|---|---|
| `sessions` | uma sessão: agente, objetivo, heartbeat, ponto de retomada, bloqueios |
| `kv` | **o objeto que a sessão seta e recupera** (qualquer JSON) |
| `events` | jornal append-only do que aconteceu |
| `gates` | resultado de cada verificação (`ok`, detalhe, commit) — consultável |
| `tasks` / `handoffs` | espelhos do roadmap e dos handoffs, para query |
| `artifacts` | o que foi construído e onde encontrar |

Arquitetura: **meta-classe** (`EntityMeta` deriva DDL, coerção e validação da
declaração), **factory** (`defineEntity` → `createStore` → `repositories`) e
**repositório** (`insert/get/list/update/upsert/remove/query`) — filtros passam por
um construtor que **recusa coluna fora do schema**, então injeção vira erro claro.
Pelo runtime WASI a leitura está em `/api/store`, `/api/store/<coleção>` e
`/api/session`; **escrita por API é recusada de propósito** (a porta aparece em
previews): escrever é pelo CLI.

## Segredos: onde a credencial mora (e onde não mora)

Nada neste repositório guarda token — nem o `access.json`, nem o ledger, nem o
`kv`. Três camadas, todas verificáveis:

| camada | como autentica | onde é conferido |
|---|---|---|
| workflows | `GITHUB_TOKEN` **efêmero**, criado pelo Actions a cada run (é assim que o gate commita handoff e comenta no PR) | `.github/workflows/*.yml` |
| sessão local/agente | `gh auth status` do ambiente (a credencial da Arena, nunca um arquivo) | `access.json > credentials.check` |
| store/descriptor | **não carregam credencial**: escrita com cara de token é recusada | `npm run validate:store` · `npm run validate:access` |

Se um dia for preciso agir por API fora do Actions, o caminho é o mesmo desta
sessão (conexão do ambiente ou `GITHUB_TOKEN` do workflow) — **nunca** um PAT
versionado ou guardado em `kv`, que é justamente o que os validadores reprovam.

## Branch nova, sem narração

Criou a branch depois do merge? Rode `npm run continuity:start -- --auto` (ou simplesmente
abra o PR: o workflow `continuity-gate` cria e commita o handoff para você). A escolha do
escopo é determinística e registrada no próprio handoff (`history[].note`):

| nome da branch | escopo inferido |
|---|---|
| `feat/401-observability-dashboards` | tarefa **T-401** (id reconhecido em qualquer grafia) |
| `fix/acessibilidade-das-abas` | tarefa cujo **título** casa (acentos ignorados) |
| `spike/wasi-runtime-hardening` | **spec** `12-wasi-runtime` + as tarefas abertas dele |
| `feat/qualquer-coisa` | **ponto de retomada**: a primeira tarefa aberta sem bloqueio (hoje `T-308`) |
| `dev`, `staging`, `main` | **promoção**: sem handoff, escopo de arquivos não se aplica |

Se ainda assim o escopo não servir, `--task`/`--spec` têm precedência e o handoff é
mesclado (nunca perdido). O CI confere tudo outra vez no PR.

O gate também **repara** um handoff que exista porém sem escopo (criado à mão ou por uma
versão anterior): ele infere de novo e commita, em vez de travar o PR num beco sem saída.

## Adicionar trabalho novo

1. Abra `.kiro/state/roadmap.json` e acrescente a tarefa na fase correspondente:
   ```json
   {
     "id": "T-406",
     "title": "Descrição curta e verificável",
     "status": "todo",
     "paths": ["caminho/que/pode/tocar/**"],
     "verify": "comando que PROVA a entrega",
     "dependsOn": ["T-402"]
   }
   ```
2. `paths` é o contrato de escopo — se a tarefa tocar algo fora dele, o gate avisa.
3. `verify` é o critério de aceite — quem retomar depois sabe exatamente como fechar.
4. Se a tarefa precisa de um spec novo, adicione-o em `policy.json > scopes` com seus caminhos.
5. `npm run continuity:check` deve passar antes de commitar.

## Por que isso resolve "continuar de onde parou"

- **Antes do merge:** o gate prova que o PR está dentro do escopo, que o roadmap
  reflete a realidade e que o núcleo foi revalidado depois da última mudança.
- **No merge:** `continuity-sync` mede os invariantes objetivos (testes, wasm,
  build, lint, docker) e grava o estado com o SHA verificado.
- **Depois do merge, em qualquer branch nova:** o handoff é inferido do roadmap
  (`inferScope`) — se o nome da branch cita uma tarefa/spec, o escopo é exato; se não
  cita nada, ela **herda o ponto de retomada** (primeira tarefa aberta e sem bloqueio)
  em vez de falhar. `npm run continuity:resume` imprime o mesmo briefing que o gate
  publica no PR: fase atual, próximas tarefas, bloqueios e guardrails.

Guardrails que o estado carrega junto (de `policy.json > resume.guardrails`):
wasm ≡ TypeScript, sem segredos versionados, navegador nunca chama `localhost`
(usa `/api/*` via proxy) e artefatos de build são gerados por script.

## Comandos

```bash
npm run continuity:status    # fase atual, progresso, próximas tarefas
npm run continuity:resume    # briefing de retomada (RESUME.md)
npm run continuity:start     # cria/atualiza o handoff desta branch
npm run continuity:check     # gate (mesmo do CI) · --json para máquina
npm run continuity:sync      # mede invariantes e atualiza o estado · --fast, --pages
npm run continuity:access    # descriptor de acesso (JSON da retomada) · --json
npm run validate:access      # confere o descriptor (roda no gate)
npm run store -- …           # ledger: set/get/query/gate/session/export
npm run validate:store       # confere o ledger (roda no gate)
```

Spec completa: [`.kiro/specs/17-continuity-gate.md`](.kiro/specs/17-continuity-gate.md)
