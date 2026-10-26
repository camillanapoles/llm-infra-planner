# Ponto de retomada — LLMcalc

> Briefing automático para a próxima sessão (humana ou agente). Gerado 2026-10-26T13:14:40.311Z.

## Onde estamos

- Fase **P3 — WebAssembly e entrega multi-ambiente**, 63% do roadmap (25/40 tarefas).
- Estado consolidado a partir de `` @ `c3b8f33`.
- Sem handoff para a branch atual — rode `npm run continuity:start` para criar um.

## Próximas tarefas (ordem do roadmap)

| # | tarefa | título | fase | bloqueio | aceite |
|---|---|---|---|---|---|
| 1 | `T-308` | Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs) | P3 | — | `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` |
| 2 | `T-412` | Smoke test das imagens Docker no push (imagem puxada do GHCR falha após o push) | P3 | — | `gh run list --workflow=docker.yml --limit 1 --json conclusion -q ".[0].conclusion"` |
| 3 | `T-401` | Suíte e2e Playwright (rotas, share URL, paridade wasm visível) | P4 | — | `npm run test:e2e` |
| 4 | `T-403` | Code-splitting do bundle (chunk principal ~700 kB) | P4 | — | `npm run build` |
| 5 | `T-404` | Cobertura de testes do store e das rotas | P4 | — | `npm test` |

## Últimos commits

```
c3b8f33 chore(continuity): sync project state [skip ci]
a031e86 Merge pull request #5 from camillanapoles/arena/b62e79c4-llm-infra-planner
e1c5a67 fix(pages): ordem do contrato do artefato + pitch pinado em teste
e9faff5 feat(pages): pitch executivo em /executivo/ com zero conflito com o app
1d4ba1e fix(gate): declara escopo T-703 no handoff e no roadmap
```

## Guardrails (não negociáveis)

- wasm (wasm/kernel.ts) e TypeScript (src/lib/formulas) precisam continuar numericamente idênticos — npm run wasm:verify + npm test provam isso.
- Nada de segredo em arquivo versionado; configuração entra por VITE_* / secrets do GitHub.
- O browser nunca chama localhost: o runtime WASI é acessado por /api/* via proxy (vite em dev, nginx no container).
- Build ignore artefatos: public/wasm, wasi/dist e _site são gerados por script.
- Um PR = um escopo: declare as tarefas no handoff da branch antes de abrir o PR.

## Comandos para retomar

```bash
npm ci
npm run continuity:resume
npm run build:wasm && npm run wasm:verify
npm test
npm run stack            # página :5173 + runtime WASI :8787
```

## Fluxo de continuidade

```bash
npm run continuity:start -- --task T-xxx   # declara o escopo desta branch
npm run continuity:check                   # gate local (o CI roda o mesmo)
npm run continuity:sync                    # mede invariantes e atualiza o estado
```

Roadmap completo: `.kiro/state/roadmap.json` · política do gate: `.kiro/state/policy.json` · fases abertas: P3, P4, P5, P6, P7

