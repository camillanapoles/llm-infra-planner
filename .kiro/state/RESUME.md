# Ponto de retomada — LLMcalc

> Briefing automático para a próxima sessão (humana ou agente). Gerado 2026-10-13T19:25:19.965Z.

## Onde estamos

- Fase **P3 — WebAssembly e entrega multi-ambiente**, 65% do roadmap (24/37 tarefas).
- Estado consolidado a partir de `` @ `e3dd0f9`.
- Sem handoff para a branch atual — rode `npm run continuity:start` para criar um.

## Próximas tarefas (ordem do roadmap)

| # | tarefa | título | fase | bloqueio | aceite |
|---|---|---|---|---|---|
| 1 | `T-308` | Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs) | P3 | — | `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` |
| 2 | `T-401` | Suíte e2e Playwright (rotas, share URL, paridade wasm visível) | P4 | — | `npm run test:e2e` |
| 3 | `T-403` | Code-splitting do bundle (chunk principal ~700 kB) | P4 | — | `npm run build` |
| 4 | `T-404` | Cobertura de testes do store e das rotas | P4 | — | `npm test` |
| 5 | `T-405` | Auditoria de acessibilidade (foco, ARIA das abas, contraste) | P4 | — | `npm run test:e2e` |

## Últimos commits

```
e3dd0f9 Merge pull request #1 from camillanapoles/arena/fe62ce6d-llm-infra-planner
9bb7629 fix(pipeline): the health gate records that it ran, not that the project is done
2612a73 [pipeline] complete T-410
91cd164 docs: a commit message that mentions the skip marker skips every workflow
6862f67 fix(pipeline): a committed test artifact, and a filter that ate the directive
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

