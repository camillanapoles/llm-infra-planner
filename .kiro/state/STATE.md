# Estado do projeto — LLMcalc

> Gerado automaticamente por `npm run continuity:sync` em 2026-10-07T17:50:34.469Z (branch `arena/fe62ce6d-llm-infra-planner` @ `b6a3128`).
> Não edite à mão: a fonte são `.kiro/state/roadmap.json`, `policy.json` e os handoffs em `.kiro/state/branches/`.

**Fase atual:** `P3` — WebAssembly e entrega multi-ambiente · **progresso:** 15/29 tarefas (52%)

| fase | nome | status | tarefas | aberto |
|---|---|---|---|---|
| ✓ P1 | Kernel de cálculo e base de dados | done | 4/4 (100%) | — |
| ✓ P2 | Experiência da página | done | 4/4 (100%) | — |
| ▶ P3 | WebAssembly e entrega multi-ambiente | in_progress | 7/8 (88%) | T-308 |
| · P4 | Qualidade contínua | todo | 0/5 (0%) | T-401, T-402, T-403, T-404, T-405 |
| · P5 | Dados vivos | todo | 0/3 (0%) | T-501, T-502, T-503 |
| · P6 | Runtime WASM avançado | todo | 0/3 (0%) | T-601, T-602, T-603 |
| · P7 | Publicação e comunidade | todo | 0/2 (0%) | T-701, T-702 |

## Próximas tarefas

| tarefa | título | fase | bloqueio | verificação |
|---|---|---|---|---|
| `T-308` | Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs) | P3 | — | `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` |
| `T-401` | Suíte e2e Playwright (rotas, share URL, paridade wasm visível) | P4 | — | `npm run test:e2e` |
| `T-402` | Zerar o lint legado (20 erros / 5 avisos herdados) | P4 | — | `npm run lint` |
| `T-403` | Code-splitting do bundle (chunk principal ~700 kB) | P4 | — | `npm run build` |
| `T-404` | Cobertura de testes do store e das rotas | P4 | — | `npm test` |

## Invariantes medidas

| métrica | valor |
|---|---|
| testes passando | 288 em 22 arquivos |
| kernel wasm (browser) | 2057 bytes |
| módulo WASI | 5728 bytes |
| verificações wasm | 16 |
| build | ok (chunk 701.7 kB) |
| lint | 20 erros / 5 avisos |
| validações docker | 16 |

## Gates

| gate | resultado | detalhe |
|---|---|---|
| `wasm-verify` | ✓ | 16 verificações ok |
| `docker-static` | ✓ | 16 validações estáticas |
| `tests` | ✓ | 288 testes / 22 arquivos |
| `build` | ✓ | bundle principal 701.7 kB |
| `lint` | ✗ | 20 erros / 5 avisos |

