# Modelo de cobrança de LLMs abertos no Brasil — base estratégica

> Derivado do pitch `pitch/index.html` (GitHub Pages via `.github/workflows/pitch-pages.yml`).
> Custos calculados com os dados do próprio repo (`src/data/cloud.json`, `exchange-rates.json`
> US$ 1 = R$ 4,9639) e a fórmula `computeCostMetrics()` (`src/lib/formulas/cost-metrics.ts`):
> `custo/1M = custo-hora ÷ (tok/s × 3600) × 1e6 ÷ utilização`.

## 1. Unit economics (premissas de planejamento, validar com benchmark vLLM)

| Config | GPU | US$/h | tok/s* | Custo/1M @50% | GPU/mês (R$) |
|---|---|---|---|---|---|
| Eco 8B FP8/INT4 | L4 24GB (AWS g6.xlarge) | 0,805 | ~2.500 | **R$ 0,89** | 2.917 |
| Pro 70B INT4 | A100 80GB | 1,39 | ~600 | **R$ 6,39** | 5.037 |
| Pro 70B FP16 | H100 80GB | 2,69 | ~1.400 | **R$ 5,30** | 9.748 |

*Regra de ouro: a 30% de utilização o H100 vai a R$ 8,83/1M. Utilização manda no negócio —
por isso o desenho é assinatura com cota (receita fixa) + excedente por token.*

## 2. Concorrência / quanto é cobrado (out/2026 — revalidar antes de proposta)

| Referência | Preço |
|---|---|
| Maritaca Sabiazinho-4 API | R$ 1,00 in / R$ 4,00 out por 1M |
| Maritaca Sabiá-4 API | R$ 5,00 / R$ 20,00 por 1M · MariTalk Premium R$ 59,90/mês |
| OpenAI GPT-4o-mini | US$ 0,15 / US$ 0,60 por 1M (≈ R$ 0,74 / 2,98) |
| OpenAI GPT-4o · Claude Sonnet | US$ 2,50–3 / US$ 10–15 por 1M (≈ R$ 12–15 / 50–74) |
| Assento corporativo (ChatGPT Business, Copilot, Gemini Ent.) | US$ 20–30/usuário/mês (≈ R$ 99–149) |

Fontes: maritaca.ai/pricing, platform.openai.com/docs/pricing, páginas oficiais de
pricing corporativo, faixas públicas RunPod/Lambda para GPU. Links completos no rodapé do pitch.

## 3. Preço de venda proposto

- **API pay-as-you-go:** Eco R$ 1,50 in / R$ 6,00 out · Pro R$ 5,00 / R$ 20,00 (teto Sabiá-4), batch/noturno −50%.
- **Starter R$ 49/mês:** 8B privado, 3M tokens, RAG 1 base/500 docs.
- **Pro R$ 149/mês:** 8B+70B, 12M tokens, RAG 5 bases/10k docs, conectores.
- **Enterprise Private R$ 249/assento/mês** (mín. 10, setup R$ 15–50 mil) ou flat dedicado
  R$ 4.900–19.900/mês por GPU: VPC/on-prem, SSO, DPA/LGPD, fine-tune LoRA, SLA.

Break-even de referência: pool fixo ≈ R$ 9 mil/mês ÷ contribuição ≈ R$ 133/usuário Pro ≈ **68 usuários**.

## 4. Receita de como fazer (resumo)

1. **Dimensionar** com o LLMcalc (VRAM, throughput, custo) antes de alugar GPU.
2. **Servir** com vLLM quantizado (FP8/AWQ), batching contínuo, prefix cache, autoscaling por fila.
3. **RAG**: ingestão → chunking → embeddings multilíngues → pgvector/Qdrant → resposta com citação.
4. **Medir/cobrar**: gateway com auth, rate-limit, metering in/out por tenant; Asaas (Pix) ou Stripe.
5. **Proteger**: multi-tenant isolado, criptografia, DPA/LGPD, opção de região Brasil.
6. **Vender**: setores onde API pública é vetada (jurídico, saúde, financeiro, governo), piloto pago de 30 dias.

## 5. Publicação

- Pitch: `pitch/index.html` → GitHub Pages pelo workflow `pitch-pages.yml`
  (Action: https://github.com/camillanapoles/llm-infra-planner/actions/workflows/pitch-pages.yml;
  URL pública após habilitar Settings → Pages → Source: **GitHub Actions** e rodar o workflow:
  https://camillanapoles.github.io/llm-infra-planner/).
- Apresentação anterior (modelo de negócio do LLMcalc) permanece em `apresentacao/` + `presentation.yml`.
