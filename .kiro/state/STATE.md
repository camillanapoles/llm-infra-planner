# Estado do projeto — LLMcalc

> Gerado automaticamente por `npm run continuity:sync` em 2026-10-12T00:09:01.484Z (branch `arena/fe62ce6d-llm-infra-planner` @ `bc3ef18`).
> Não edite à mão: a fonte são `.kiro/state/roadmap.json`, `policy.json` e os handoffs em `.kiro/state/branches/`.

**Fase atual:** `P3` — WebAssembly e entrega multi-ambiente · **progresso:** 20/33 tarefas (61%)

| fase | nome | status | tarefas | aberto |
|---|---|---|---|---|
| ✓ P1 | Kernel de cálculo e base de dados | done | 4/4 (100%) | — |
| ✓ P2 | Experiência da página | done | 4/4 (100%) | — |
| ▶ P3 | WebAssembly e entrega multi-ambiente | in_progress | 10/11 (91%) | T-308 |
| · P4 | Qualidade contínua | todo | 2/6 (33%) | T-401, T-403, T-404, T-405 |
| · P5 | Dados vivos | todo | 0/3 (0%) | T-501, T-502, T-503 |
| · P6 | Runtime WASM avançado | todo | 0/3 (0%) | T-601, T-602, T-603 |
| · P7 | Publicação e comunidade | todo | 0/2 (0%) | T-701, T-702 |

## Próximas tarefas

| tarefa | título | fase | bloqueio | verificação |
|---|---|---|---|---|
| `T-308` | Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs) | P3 | — | `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` |
| `T-401` | Suíte e2e Playwright (rotas, share URL, paridade wasm visível) | P4 | — | `npm run test:e2e` |
| `T-403` | Code-splitting do bundle (chunk principal ~700 kB) | P4 | — | `npm run build` |
| `T-404` | Cobertura de testes do store e das rotas | P4 | — | `npm test` |
| `T-405` | Auditoria de acessibilidade (foco, ARIA das abas, contraste) | P4 | — | `npm run test:e2e` |

## Invariantes medidas

| métrica | valor |
|---|---|
| testes passando | 361 em 24 arquivos |
| kernel wasm (browser) | 2057 bytes |
| módulo WASI | 5728 bytes |
| verificações wasm | 16 |
| build | ok (chunk 701.89 kB) |
| lint | 0 erros / 0 avisos |
| validações docker | 16 |

## Gates

| gate | resultado | detalhe |
|---|---|---|
| `wasm-verify` | ✓ | 16 verificações ok |
| `docker-static` | ✓ | 16 validações estáticas |
| `tests` | ✓ | 361 testes / 24 arquivos |
| `build` | ✓ | bundle principal 701.89 kB |
| `lint` | ✓ | 0 erros / 0 avisos |
| `pages-artifact` | ✓ | 3/3 ambientes |

