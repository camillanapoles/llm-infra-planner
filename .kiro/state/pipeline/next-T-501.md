# Próxima issue — T-501

> Gerado pelo pipeline gate-driven em 2026-10-13T14:33:19.959Z · branch `arena/fe62ce6d-llm-infra-planner` @ `c4fea86` · veredito `task-complete`

## Instrução

```
T-501 — Rodar e validar os workflows de atualização de preços/hardware
Fase: P5 · Dados vivos · fila 7/14 · índice 29
Teste de aceite: `gh workflow run refresh-prices.yml` retorna 0
Escopo permitido: .github/workflows/refresh-prices.yml, scripts/refresh-*.ts, src/data/**
Bloqueios: nenhum — pode começar
Fechar com: npm run pipeline -- complete T-501 --json
```

## Por que esta

- Primeira tarefa aberta na ordem do roadmap (fila 7/14, índice 29).
- Sem bloqueios: acionável imediatamente.

## Ciclo

1. Executar a tarefa dentro do escopo declarado.
2. `npm run pipeline -- complete T-501 --json` (roda o teste de aceite, grava gate no ledger).
3. Sucesso → a próxima issue é construída e indexada automaticamente. Falha → erro tipo 1 com o log e as informações de continuidade.
