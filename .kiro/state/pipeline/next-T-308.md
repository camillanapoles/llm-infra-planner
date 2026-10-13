# Próxima issue — T-308

> Gerado pelo pipeline gate-driven em 2026-10-13T18:17:41.781Z · branch `arena/fe62ce6d-llm-infra-planner` @ `01be80f` · veredito `continuity`

## Instrução

```
T-308 — Publicar os três ambientes após o merge (rodar o bootstrap e validar URLs)
Fase: P3 · WebAssembly e entrega multi-ambiente · fila 1/14 · índice 16
Teste de aceite: `gh workflow run bootstrap-repo.yml && gh run list --workflow=deploy-pages.yml` retorna 0
Escopo permitido: .github/workflows/deploy-pages.yml, .kiro/state/**
Spec: .kiro/specs/13-deploy-github-pages.md
Bloqueios: nenhum — pode começar
Fechar com: npm run pipeline -- complete T-308 --json
```

## Por que esta

- Primeira tarefa aberta na ordem do roadmap (fila 1/14, índice 16).
- Sem bloqueios: acionável imediatamente.

## Pendências do gate de saúde

- 14 item(ns) aberto(s) em roadmap: T-308, T-401, T-403 …

## Ciclo

1. Executar a tarefa dentro do escopo declarado.
2. `npm run pipeline -- complete T-308 --json` (roda o teste de aceite, grava gate no ledger).
3. Sucesso → a próxima issue é construída e indexada automaticamente. Falha → erro tipo 1 com o log e as informações de continuidade.
