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
#    ou, para inferir pelo nome da branch:
npm run continuity:start -- --auto

# 3. trabalhar… e então validar localmente com o MESMO gate do CI
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

O gate roda em **todo PR** contra `main`/`dev`/`staging`
(`.github/workflows/continuity-gate.yml`) e publica um comentário com o
**ponto de retomada** + o roadmap. Merges na `main` consolidam o estado
(`.github/workflows/continuity-sync.yml`).

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
- **Depois do merge, em qualquer branch nova:** `npm run continuity:resume`
  imprime o briefing com fase atual, próximas tarefas, bloqueios e guardrails; o
  handoff da branch nova herda o ponto de parada anterior.

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
```

Spec completa: [`.kiro/specs/17-continuity-gate.md`](.kiro/specs/17-continuity-gate.md)
