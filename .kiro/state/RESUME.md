# Ponto de retomada — LLMcalc

> Briefing automático para a próxima sessão (humana ou agente). Gerado 2026-10-07T18:06:13.155Z.

## Onde estamos

- Fase **P3 — WebAssembly e entrega multi-ambiente**, 52% do roadmap (15/29 tarefas).
- Estado consolidado a partir de `arena/fe62ce6d-llm-infra-planner` @ `44cdf0a`.
- Esta branch (`arena/fe62ce6d-llm-infra-planner`) tem escopo declarado: tarefas T-301, T-302, T-303, T-304, T-305, T-306, T-307, T-104; specs 11-wasm-kernel, 12-wasi-runtime, 13-deploy-github-pages, 14-deploy-docker, 15-deploy-local, 16-branch-environments-bootstrap, 17-continuity-gate.
- Resumo do handoff: Entrega do kernel WebAssembly + runtime WASI + deploy em 3 ambientes (T-301..T-306) e implantação do gate de continuidade por estado (T-307).
- Próximos passos já registrados nesta branch:
  - T-307: rodar `npm run continuity:check` e `npm run continuity:sync` (gate verde)
  - Merge do PR #1 na main e então T-308: `gh workflow run bootstrap-repo.yml` para publicar dev/staging/produção
  - Após o merge, seguir as tarefas abertas da fase P4 (T-401 e2e, T-402 lint legado)
- Bloqueios: T-308 depende do merge do PR #1 (workflows precisam existir na branch default)

## Próximas tarefas (ordem do roadmap)

| # | tarefa | título | fase | bloqueio | aceite |
|---|---|---|---|---|---|
| 1 | `T-308` | Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs) | P3 | — | `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` |
| 2 | `T-401` | Suíte e2e Playwright (rotas, share URL, paridade wasm visível) | P4 | — | `npm run test:e2e` |
| 3 | `T-402` | Zerar o lint legado (20 erros / 5 avisos herdados) | P4 | — | `npm run lint` |
| 4 | `T-403` | Code-splitting do bundle (chunk principal ~700 kB) | P4 | — | `npm run build` |
| 5 | `T-404` | Cobertura de testes do store e das rotas | P4 | — | `npm test` |

## Últimos commits

```
44cdf0a feat(continuity): a new branch infers its own scope, including the resume point
6f631e6 fix(ci): correct the Pages artifact verification (loop skipped 'dev/')
064c48b fix(pages): build wasm artifacts before the Pages artifact
24a41d1 fix(lint): drop unused import in continuity CLI + add lint:changed script
9b9024f fix(ci): repair duplicate env key in continuity-sync + validate workflow files
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

