/**
 * Núcleo do pipeline gate-driven (puro — sem I/O).
 *
 * Duas decisões moram aqui:
 *
 *   1. `evaluateHealth` — o gatilho de saúde. Positivo SOMENTE quando não há
 *      issue/tarefa aberta, nenhuma execução de CI com erro e os testes existem
 *      e passam (e toda tarefa aberta tem instrução de teste). Enquanto não for
 *      positivo o veredito é `continuity`: há trabalho em voo, o pipeline
 *      continua em vez de declarar pronto.
 *
 *   2. `buildNextIssueInstruction` — ao concluir uma issue com sucesso, a
 *      seguinte é CONSTRUÍDA e INDEXADA (id, índice, teste de aceite, escopo,
 *      bloqueios) para ser entregue junto. Em falha, a issue devolvida é a
 *      MESMA, marcada como `retry`.
 */
import type { ExitCode } from './result.js';
import { EXIT } from './result.js';
import type { NextIssue, ResultStatus } from './result.js';

// ─── Tarefa no formato plano do roadmap (espelha `flattenTasks`) ─────────────

export interface PipelineTask {
  id: string;
  title: string;
  status: string;
  phase?: string;
  phaseName?: string;
  spec?: string;
  paths?: string[];
  verify?: string;
  blockedBy?: string[];
}

// ─── Saúde ───────────────────────────────────────────────────────────────────

export interface IssueSource {
  /** De onde os work items vêm: GitHub Issues quando habilitado, senão o roadmap. */
  source: 'github' | 'roadmap';
  available: boolean;
  open: { id: string; title: string }[];
  reason?: string;
}

export interface CiSource {
  available: boolean;
  /** Execuções concluídas COM ERRO (failure/timed_out/action_required). */
  failures: { name: string; conclusion: string; url?: string }[];
  /** Execuções em andamento — informativo: um gate que se espera nunca fecha. */
  inProgress: number;
  checked: number;
  reason?: string;
}

export interface TestSource {
  available: boolean;
  files: number;
  passed: number;
  failed: number;
  ok: boolean;
  reason?: string;
}

export interface HealthInput {
  branch: string;
  headSha: string;
  at: string;
  issues: IssueSource;
  ci: CiSource;
  tests: TestSource;
  /** TODAS as tarefas, na ordem do roadmap. */
  tasks: PipelineTask[];
}

export interface HealthReport {
  verdict: ResultStatus;
  exitCode: ExitCode;
  positive: boolean;
  blockers: string[];
  nextIssue: NextIssue | null;
  checks: {
    openWork: number;
    ciFailures: number;
    testsOk: boolean;
    tasksWithoutTest: string[];
  };
}

export function evaluateHealth(input: HealthInput): HealthReport {
  const blockers: string[] = [];

  // 1. Issues abertas (GitHub quando habilitado; senão as tarefas do roadmap).
  if (!input.issues.available) {
    blockers.push(`issues: fonte indisponível (${input.issues.reason ?? 'motivo desconhecido'})`);
  } else if (input.issues.open.length > 0) {
    blockers.push(`${input.issues.open.length} item(ns) aberto(s) em ${input.issues.source}: ${input.issues.open.slice(0, 3).map(i => i.id).join(', ')}${input.issues.open.length > 3 ? ' …' : ''}`);
  }

  // 2. CI/CD com erro.
  if (!input.ci.available) {
    blockers.push(`ci: indisponível (${input.ci.reason ?? 'motivo desconhecido'})`);
  } else if (input.ci.failures.length > 0) {
    blockers.push(`${input.ci.failures.length} execução(ões) de CI com erro: ${input.ci.failures.slice(0, 3).map(f => `${f.name}=${f.conclusion}`).join(', ')}`);
  }

  // 3. Sem testes / testes vermelhos.
  if (!input.tests.available) {
    blockers.push(`testes: indisponível (${input.tests.reason ?? 'motivo desconhecido'})`);
  } else if (input.tests.files === 0) {
    blockers.push('testes: nenhum arquivo de teste encontrado');
  } else if (!input.tests.ok) {
    blockers.push(`testes: ${input.tests.failed} falhando`);
  }

  // 4. Instrução de teste por tarefa aberta — "sem testes" também é tarefa que
  //    não diz como se prova. Isso é entrega sem aceite, não entrega pronta.
  const openTasks = input.tasks.filter(task => task.status !== 'done');
  const tasksWithoutTest = openTasks.filter(task => !task.verify || !task.verify.trim()).map(task => task.id);
  if (tasksWithoutTest.length > 0) {
    blockers.push(`${tasksWithoutTest.length} tarefa(s) aberta(s) sem instrução de teste: ${tasksWithoutTest.slice(0, 3).join(', ')}${tasksWithoutTest.length > 3 ? ' …' : ''}`);
  }

  // Estrutural: sem roadmap não há fila — erro tipo 2, não continuidade.
  if (input.tasks.length === 0) {
    return {
      verdict: 'error',
      exitCode: EXIT.fatal,
      positive: false,
      blockers: ['roadmap sem tarefas — a fila de issues é a fonte de verdade do pipeline'],
      nextIssue: null,
      checks: { openWork: 0, ciFailures: 0, testsOk: false, tasksWithoutTest: [] },
    };
  }

  const positive = blockers.length === 0;
  return {
    verdict: positive ? 'success' : 'continuity',
    exitCode: positive ? EXIT.success : EXIT.continuity,
    positive,
    blockers,
    nextIssue: positive ? null : buildNextIssueInstruction(input.tasks),
    checks: {
      openWork: input.issues.open.length,
      ciFailures: input.ci.failures.length,
      testsOk: input.tests.available && input.tests.ok,
      tasksWithoutTest,
    },
  };
}

// ─── Próxima issue (indexada) ────────────────────────────────────────────────

export function buildNextIssueInstruction(
  tasks: PipelineTask[],
  options: { fromId?: string; reason?: NextIssue['reason']; retryId?: string } = {},
): NextIssue | null {
  const reason = options.reason ?? 'next';
  const open = tasks.filter(task => task.status !== 'done');
  if (open.length === 0) return null;

  // `fromId`: a próxima é a primeira aberta DEPOIS daquela; sem ele, a primeira da fila.
  let chosen = open[0];
  if (options.fromId) {
    const position = tasks.findIndex(task => task.id === options.fromId);
    const after = position >= 0 ? tasks.slice(position + 1).find(task => task.status !== 'done') : undefined;
    chosen = after ?? open[0];
  }
  if (options.retryId) chosen = tasks.find(task => task.id === options.retryId) ?? chosen;

  const index = tasks.findIndex(task => task.id === chosen.id) + 1; // 1-based na sequência completa
  const queuePosition = open.findIndex(task => task.id === chosen.id) + 1;
  const blockedBy = chosen.blockedBy ?? [];
  const actionable = blockedBy.length === 0;

  const acceptance = chosen.verify
    ? `\`${chosen.verify}\` retorna 0`
    : 'sem teste definido — declare `verify` no roadmap antes de executar';

  const lines = [
    `${chosen.id} — ${chosen.title}`,
    `Fase: ${chosen.phase ?? '?'}${chosen.phaseName ? ` · ${chosen.phaseName}` : ''} · fila ${queuePosition}/${open.length} · índice ${index}`,
    `Teste de aceite: ${acceptance}`,
    chosen.paths?.length ? `Escopo permitido: ${chosen.paths.join(', ')}` : 'Escopo permitido: (declarar no roadmap)',
    chosen.spec ? `Spec: .kiro/specs/${chosen.spec}.md` : '',
    blockedBy.length ? `Bloqueios: ${blockedBy.join(', ')} — resolver antes de começar` : 'Bloqueios: nenhum — pode começar',
    `Fechar com: npm run pipeline -- complete ${chosen.id} --json`,
  ].filter(Boolean);

  return {
    id: chosen.id,
    index,
    queuePosition,
    queueTotal: open.length,
    title: chosen.title,
    phase: chosen.phase,
    phaseName: chosen.phaseName,
    spec: chosen.spec,
    verify: chosen.verify,
    paths: chosen.paths,
    acceptance,
    instruction: lines.join('\n'),
    blockedBy,
    actionable,
    reason: options.retryId ? 'retry' : reason,
  };
}

/** Render legível da instrução — o anexo `.md` entregue junto com a próxima issue. */
export function renderInstructionMd(issue: NextIssue, context: { branch: string; headSha: string; at: string; verdict: string; blockers?: string[] }): string {
  return [
    `# Próxima issue — ${issue.id}`,
    '',
    `> Gerado pelo pipeline gate-driven em ${context.at} · branch \`${context.branch}\` @ \`${context.headSha.slice(0, 7)}\` · veredito \`${context.verdict}\``,
    '',
    '## Instrução',
    '',
    '```',
    issue.instruction,
    '```',
    '',
    '## Por que esta',
    '',
    issue.reason === 'retry'
      ? '- A verificação anterior falhou: a MESMA issue volta com o log anexado.'
      : `- Primeira tarefa aberta na ordem do roadmap (fila ${issue.queuePosition}/${issue.queueTotal}, índice ${issue.index}).`,
    issue.blockedBy.length ? `- Bloqueada por: ${issue.blockedBy.join(', ')}.` : '- Sem bloqueios: acionável imediatamente.',
    '',
    ...(context.blockers?.length ? ['## Pendências do gate de saúde', '', ...context.blockers.map(b => `- ${b}`), ''] : []),
    '## Ciclo',
    '',
    '1. Executar a tarefa dentro do escopo declarado.',
    '2. `npm run pipeline -- complete ' + issue.id + ' --json` (roda o teste de aceite, grava gate no ledger).',
    '3. Sucesso → a próxima issue é construída e indexada automaticamente. Falha → erro tipo 1 com o log e as informações de continuidade.',
    '',
  ].join('\n');
}
