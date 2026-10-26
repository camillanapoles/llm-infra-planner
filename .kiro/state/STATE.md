# Estado do projeto — LLMcalc

> Gerado automaticamente por `npm run continuity:sync` em 2026-10-26T13:14:40.311Z (branch `` @ `c3b8f33`).
> Não edite à mão: a fonte são `.kiro/state/roadmap.json`, `policy.json` e os handoffs em `.kiro/state/branches/`.

**Fase atual:** `P3` — WebAssembly e entrega multi-ambiente · **progresso:** 25/40 tarefas (63%)

| fase | nome | status | tarefas | aberto |
|---|---|---|---|---|
| ✓ P1 | Kernel de cálculo e base de dados | done | 4/4 (100%) | — |
| ✓ P2 | Experiência da página | done | 4/4 (100%) | — |
| ▶ P3 | WebAssembly e entrega multi-ambiente | in_progress | 11/13 (85%) | T-308, T-412 |
| · P4 | Qualidade contínua | todo | 6/10 (60%) | T-401, T-403, T-404, T-405 |
| · P5 | Dados vivos | todo | 0/3 (0%) | T-501, T-502, T-503 |
| · P6 | Runtime WASM avançado | todo | 0/3 (0%) | T-601, T-602, T-603 |
| · P7 | Publicação e comunidade | todo | 0/3 (0%) | T-701, T-702, T-703 |

## Próximas tarefas

| tarefa | título | fase | bloqueio | verificação |
|---|---|---|---|---|
| `T-308` | Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs) | P3 | — | `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` |
| `T-412` | Smoke test das imagens Docker no push (imagem puxada do GHCR falha após o push) | P3 | — | `gh run list --workflow=docker.yml --limit 1 --json conclusion -q ".[0].conclusion"` |
| `T-401` | Suíte e2e Playwright (rotas, share URL, paridade wasm visível) | P4 | — | `npm run test:e2e` |
| `T-403` | Code-splitting do bundle (chunk principal ~700 kB) | P4 | — | `npm run build` |
| `T-404` | Cobertura de testes do store e das rotas | P4 | — | `npm test` |

## Invariantes medidas

| métrica | valor |
|---|---|
| verificações wasm | 20 |
| build | ok |
| lint | 0 erros / 0 avisos |
| validações docker | 21 |

## Gates

| gate | resultado | detalhe |
|---|---|---|
| `wasm-verify` | ✓ | 20 verificações ok |
| `docker-static` | ✓ | 21 validações estáticas |
| `tests` | ✓ | ? testes / ? arquivos |
| `build` | ✓ | bundle principal ? kB |
| `lint` | ✓ | 0 erros / 0 avisos |

