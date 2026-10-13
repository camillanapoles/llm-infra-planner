#!/usr/bin/env npx tsx
/**
 * Pipeline gate-driven — o fluxo issue → teste → próxima issue, como blueprint
 * executável (BPMN via gates do GitHub Actions).
 *
 *   npm run pipeline -- health [--emit] [--record] [--json] [--text]
 *       GATILHO de saúde: verifica a não-existência de issues abertas, de CI com
 *       erro e de testes ausentes/falhando. Enquanto NÃO for positivo, o veredito
 *       é `continuity` (exit 1) e a próxima issue vai junto na resposta.
 *       Positivo = exit 0. Fonte de verdade quebrada (sem roadmap) = exit 2.
 *
 *   npm run pipeline -- next [--from T-xxx] [--emit]
 *       Constrói e indexa a próxima issue (instrução completa: teste de aceite,
 *       escopo, bloqueios). Fila vazia = exit 0 com `nextIssue: null`.
 *
 *   npm run pipeline -- complete T-xxx [--dry-run] [--json]
 *       Cada issue concluída é TESTADA (roda o `verify` do roadmap) e ENTREGUE
 *       com a instrução da seguinte. Sucesso → marca `done`, grava gate + evento
 *       no ledger e devolve a próxima indexada. Falha → erro tipo 1, com log
 *       anexado e as informações de continuidade (retomada + bloqueios).
 *
 * Toda ação responde o MESMO objeto JSON (scripts/lib/result.ts): id, mensagem,
 * anexos gerados (path/filename), status, próxima issue e exitCode 0/1/2.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  flattenTasks,
  loadRoadmap,
  writeJson,
  type Roadmap,
} from './lib/continuity-core.js';
import {
  attachment,
  emitResult,
  makeResult,
  type ActionResult,
  type Attachment,
} from './lib/result.js';
import {
  buildNextIssueInstruction,
  evaluateHealth,
  renderInstructionMd,
  type CiSource,
  type IssueSource,
  type PipelineTask,
  type TestSource,
} from './lib/pipeline-core.js';
import { createStore, recordEvent, recordGate, repositories, SNAPSHOT_FILE, STORE_FILE } from './lib/store-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIPELINE_DIR = '.kiro/state/pipeline';

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const has = (name: string): boolean => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const HELP = `pipeline — fluxo gate-driven (issues · CI · testes)

  npm run pipeline -- health [--tests=run|skip] [--emit] [--record]
  npm run pipeline -- next [--from T-xxx] [--emit]
  npm run pipeline -- complete <T-xxx> [--dry-run] [--emit]

Flags: --json (padrão: o JSON é o contrato e vai sempre) · --text (resumo legível no stderr)
       --summary (grava no resumo do GitHub Actions) · --emit (gera anexos em ${PIPELINE_DIR}/)`;

function run(command: string, args: string[], options: { allowFailure?: boolean; timeout?: number; shell?: boolean } = {}): { ok: boolean; code: number; output: string } {
  try {
    const output = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 600_000,
      shell: false,
    });
    return { ok: true, code: 0, output: output.trim() };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || failure.message;
    if (options.allowFailure) return { ok: false, code: failure.status ?? 1, output };
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} falhou: ${output.slice(0, 400)}`);
  }
}

function ghJson(args: string[]): { ok: boolean; value: unknown; reason?: string } {
  const result = run('gh', args, { allowFailure: true, timeout: 60_000 });
  if (!result.ok) {
    return { ok: false, value: null, reason: result.output.split('\n')[0].slice(0, 200) };
  }
  try {
    return { ok: true, value: JSON.parse(result.output) };
  } catch {
    return { ok: false, value: null, reason: 'resposta do gh não é JSON' };
  }
}

function currentBranch(): string {
  return run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true }).output || 'HEAD';
}

function headSha(): string {
  return run('git', ['rev-parse', 'HEAD'], { allowFailure: true }).output || '';
}

// ─── Coletores (o "gatilho" olha o mundo) ────────────────────────────────────

function collectIssues(): IssueSource {
  const repo = ghJson(['repo', 'view', '--json', 'hasIssuesEnabled']).value as { hasIssuesEnabled?: boolean } | null;
  if (repo?.hasIssuesEnabled) {
    const listed = ghJson(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,labels']);
    if (listed.ok) {
      const issues = (listed.value as { number: number; title: string }[]) ?? [];
      return { source: 'github', available: true, open: issues.map(issue => ({ id: `#${issue.number}`, title: issue.title })) };
    }
    return { source: 'github', available: false, open: [], reason: listed.reason };
  }

  // Issues desabilitadas no repositório: a fila indexada do projeto é o roadmap.
  // (Documentado em PIPELINE.md — habilitar Issues no GitHub troca a fonte sem mexer no código.)
  const issuesDisabled = repo?.hasIssuesEnabled === false;
  try {
    const roadmap = loadRoadmap(root);
    const open = flattenTasks(roadmap).filter(task => task.status !== 'done');
    return {
      source: 'roadmap',
      available: true,
      open: open.map(task => ({ id: task.id, title: task.title })),
      reason: issuesDisabled ? 'GitHub Issues desabilitado — usando o roadmap (issues indexadas do projeto)' : undefined,
    };
  } catch (error) {
    return { source: 'roadmap', available: false, open: [], reason: (error as Error).message };
  }
}

function collectCi(branch: string): CiSource {
  const listed = ghJson(['run', 'list', '--branch', branch, '--limit', '10', '--json', 'name,conclusion,status,url']);
  if (!listed.ok) return { available: false, failures: [], inProgress: 0, checked: 0, reason: listed.reason };
  const runs = (listed.value as { name: string; conclusion: string | null; status: string; url?: string }[]) ?? [];
  const failures = runs
    .filter(run => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(String(run.conclusion)))
    .map(run => ({ name: run.name, conclusion: String(run.conclusion), url: run.url }));
  return { available: true, failures, inProgress: runs.filter(run => run.status === 'in_progress' || run.status === 'queued').length, checked: runs.length };
}

function collectTests(mode: 'run' | 'skip'): TestSource {
  if (mode === 'skip') return { available: false, files: 0, passed: 0, failed: 0, ok: false, reason: 'pulado por --tests=skip' };
  const result = run('npm', ['test', '--silent'], { allowFailure: true, timeout: 900_000 });
  const output = result.output;
  const passed = Number(/Tests\s+(\d+) passed/.exec(output)?.[1] ?? 0);
  const failed = Number(/Tests\s+(\d+) failed/.exec(output)?.[1] ?? 0);
  const files = Number(/Test Files\s+(\d+)/.exec(output)?.[1] ?? 0);
  return {
    available: true,
    files,
    passed,
    failed,
    ok: result.ok && failed === 0 && files > 0,
    reason: result.ok ? undefined : `npm test saiu com código ${result.code}`,
  };
}

// ─── Roadmap e ledger ────────────────────────────────────────────────────────

function pipelineTasks(roadmap: Roadmap): PipelineTask[] {
  return flattenTasks(roadmap).map(task => ({
    id: task.id,
    title: task.title,
    status: task.status,
    phase: task.phase,
    phaseName: task.phaseName,
    spec: task.spec,
    paths: task.paths,
    verify: task.verify,
    blockedBy: [],
  }));
}

interface LedgerHandle {
  repos: ReturnType<typeof repositories> | null;
  error: string | null;
}

function openLedger(): LedgerHandle {
  try {
    const store = createStore({ file: path.join(root, STORE_FILE), silent: true });
    return { repos: repositories(store), error: null };
  } catch (error) {
    return { repos: null, error: (error as Error).message };
  }
}

/**
 * Informações de continuidade que acompanham todo erro (retomada + bloqueios + último sync).
 *
 * Lê o banco local E cai para o snapshot versionado: num clone/sandbox novo o banco
 * nasce vazio, e a continuidade que interessa é justamente a que está versionada.
 */
function continuityInfo(): Record<string, unknown> {
  const ledger = openLedger();
  const snapshotPath = path.join(root, SNAPSHOT_FILE);
  const snapshot: { tables?: Record<string, Record<string, unknown>[]> } | null = fs.existsSync(snapshotPath)
    ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as { tables?: Record<string, Record<string, unknown>[]> }
    : null;

  const localSessions = ledger.repos ? ledger.repos.sessions.list({ order: { column: 'heartbeat_at', direction: 'desc' }, limit: 1 }) : [];
  const snapshotSessions = (snapshot?.tables?.sessions ?? []) as Record<string, unknown>[];
  const session = (localSessions[0] ?? snapshotSessions[0]) as { resume_point?: string; blockers?: string; goal?: string } | undefined;

  const localSync = ledger.repos ? (ledger.repos.kv.get('last_sync') as { commit?: string; at?: string; percent?: number } | null) : null;
  const snapshotSync = ((snapshot?.tables?.kv ?? []) as { key: string; value: unknown }[]).find(row => row.key === 'last_sync')?.value as { commit?: string; at?: string; percent?: number } | undefined;
  const lastSync = localSync ?? snapshotSync ?? null;

  if (!ledger.repos && !session) return { available: false, reason: ledger.error ?? 'ledger e snapshot indisponíveis' };
  let blockers: unknown = session?.blockers;
  try {
    blockers = session?.blockers ? JSON.parse(String(session.blockers)) : [];
  } catch {
    /* texto livre no campo: devolve como veio */
  }
  return {
    available: true,
    source: localSessions.length > 0 ? 'ledger' : 'snapshot',
    resume: session?.resume_point ?? session?.goal ?? null,
    blockers,
    lastSync: lastSync ? { commit: String(lastSync.commit ?? '').slice(0, 7), at: lastSync.at, percent: lastSync.percent } : null,
    snapshot: snapshot !== null,
  };
}

function writeArtifact(relative: string, content: string): Attachment {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.endsWith('\n') ? content : `${content}\n`);
  return attachment(root, relative, path.extname(relative).replace('.', '') || 'file');
}

// ─── Ações ───────────────────────────────────────────────────────────────────

function cmdHealth(): number {
  const branch = flag('--branch') ?? currentBranch();
  const at = new Date().toISOString();
  let roadmap: Roadmap;
  try {
    roadmap = loadRoadmap(root);
  } catch (error) {
    return emitResult(makeResult({
      action: 'health',
      status: 'error',
      message: `roadmap indisponível: ${(error as Error).message}`,
      details: { continuity: continuityInfo() },
      at,
    }), { text: has('--text'), summary: has('--summary') });
  }

  const tasks = pipelineTasks(roadmap);
  const issues = collectIssues();
  const ci = collectCi(branch);
  const tests = collectTests(flag('--tests') === 'skip' ? 'skip' : 'run');
  const report = evaluateHealth({ branch, headSha: headSha(), at, issues, ci, tests, tasks });

  const attachments: Attachment[] = [];
  if (has('--emit') || report.nextIssue) {
    const payload = { at, branch, headSha: headSha(), verdict: report.verdict, blockers: report.blockers, checks: report.checks, sources: { issues, ci, tests } };
    if (has('--emit')) attachments.push(writeArtifact(`${PIPELINE_DIR}/health.json`, JSON.stringify(payload, null, 2)));
    if (report.nextIssue && has('--emit')) {
      attachments.push(writeArtifact(`${PIPELINE_DIR}/next-${report.nextIssue.id}.md`, renderInstructionMd(report.nextIssue, {
        branch, headSha: headSha(), at, verdict: report.verdict, blockers: report.blockers,
      })));
    }
  }

  if (has('--record')) {
    const ledger = openLedger();
    if (ledger.repos) {
      recordGate(ledger.repos, { id: 'pipeline-health', ok: report.positive, detail: report.positive ? 'positivo (0 issues, 0 CI, testes ok)' : `${report.blockers.length} bloqueio(s)`, branch });
      recordEvent(ledger.repos, { type: 'pipeline', summary: `health ${report.verdict} — ${report.blockers.length} bloqueio(s)`, branch, data: { verdict: report.verdict, blockers: report.blockers } });
    }
  }

  const message = report.positive
    ? 'positivo: nenhuma issue aberta, nenhuma execução de CI com erro, testes existem e passam'
    : `não positivo — continuação: ${report.blockers.join(' · ')}`;

  return emitResult(makeResult({
    action: 'health',
    status: report.verdict,
    message,
    attachments,
    nextIssue: report.nextIssue,
    at,
    details: { branch, headSha: headSha(), checks: report.checks, sources: { issues: { source: issues.source, available: issues.available, open: issues.open.length, reason: issues.reason }, ci: { available: ci.available, failures: ci.failures, inProgress: ci.inProgress, checked: ci.checked, reason: ci.reason }, tests }, continuity: report.positive ? undefined : continuityInfo() },
  }), { text: has('--text'), summary: has('--summary') });
}

function cmdNext(): number {
  const at = new Date().toISOString();
  let roadmap: Roadmap;
  try {
    roadmap = loadRoadmap(root);
  } catch (error) {
    return emitResult(makeResult({ action: 'next', status: 'error', message: `roadmap indisponível: ${(error as Error).message}`, details: { continuity: continuityInfo() }, at }), { text: has('--text'), summary: has('--summary') });
  }
  const from = flag('--from') ?? undefined;
  const issue = buildNextIssueInstruction(pipelineTasks(roadmap), { fromId: from });
  const attachments: Attachment[] = [];
  if (issue && has('--emit')) {
    attachments.push(writeArtifact(`${PIPELINE_DIR}/next-${issue.id}.md`, renderInstructionMd(issue, {
      branch: currentBranch(), headSha: headSha(), at, verdict: 'next',
    })));
  }
  return emitResult(makeResult({
    action: 'next',
    status: 'success',
    message: issue ? `${issue.id} — índice ${issue.index}, fila ${issue.queuePosition}/${issue.queueTotal}${issue.actionable ? '' : ` (bloqueada por ${issue.blockedBy.join(', ')})`}` : 'fila vazia: nenhuma tarefa aberta',
    attachments,
    nextIssue: issue,
    at,
  }), { text: has('--text'), summary: has('--summary') });
}

function cmdComplete(): number {
  const at = new Date().toISOString();
  const taskId = flag('--id') ?? argv.find(arg => /^T-\d+$/.test(arg)) ?? null;
  const dryRun = has('--dry-run');

  let roadmap: Roadmap;
  try {
    roadmap = loadRoadmap(root);
  } catch (error) {
    return emitResult(makeResult({ action: 'complete', status: 'error', message: `roadmap indisponível: ${(error as Error).message}`, details: { continuity: continuityInfo() }, at }), { text: has('--text'), summary: has('--summary') });
  }
  const tasks = pipelineTasks(roadmap);
  const task = tasks.find(t => t.id === taskId);
  const action = taskId ? `complete ${taskId}` : 'complete';

  if (!task) {
    return emitResult(makeResult({
      action,
      status: 'error',
      message: taskId ? `${taskId} não existe no roadmap` : 'informe a tarefa: npm run pipeline -- complete T-xxx',
      details: { known: tasks.slice(0, 8).map(t => t.id), continuity: continuityInfo() },
      at,
    }), { text: has('--text'), summary: has('--summary') });
  }

  if (!task.verify || !task.verify.trim()) {
    return emitResult(makeResult({
      action,
      status: 'error',
      message: `${task.id} não declara instrução de teste (\`verify\`) — entrega sem aceite não é entrega: declare no roadmap antes de concluir`,
      details: { task: task.id, continuity: continuityInfo() },
      at,
    }), { text: has('--text'), summary: has('--summary') });
  }

  // Re-completar é operação idempotente: não re-testa nem re-escreve o roadmap.
  if (task.status === 'done') {
    return emitResult(makeResult({
      action,
      status: 'success',
      message: `${task.id} já estava concluída — nada a fazer (verify declarado: \`${task.verify}\`)`,
      nextIssue: buildNextIssueInstruction(tasks),
      at,
      details: { task: task.id, alreadyDone: true },
    }), { text: has('--text'), summary: has('--summary') });
  }

  // 1. TESTA — roda o `verify` declarado no roadmap.
  const verify = run('/bin/sh', ['-c', task.verify], { allowFailure: true, timeout: 1_800_000 });
  const attachments: Attachment[] = [];
  const logRelative = `${PIPELINE_DIR}/logs/${task.id}-verify.log`;
  if (verify.output) {
    attachments.push(writeArtifact(logRelative, `$ ${task.verify}\nexit ${verify.code}\n\n${verify.output}`));
  }

  // 2a. FALHOU → erro tipo 1, com log anexado e informações de continuidade.
  if (!verify.ok) {
    const retry = buildNextIssueInstruction(tasks, { retryId: task.id });
    return emitResult(makeResult({
      action,
      status: 'error',
      errorType: 1, // reprovou: o trabalho continua nesta issue (ver nextIssue.reason = retry)
      message: `${task.id} reprovada no teste de aceite \`${task.verify}\` (exit ${verify.code}) — log em ${logRelative}`,
      attachments,
      nextIssue: retry,
      at,
      details: {
        task: task.id,
        command: task.verify,
        exitCode: verify.code,
        logTail: verify.output.split('\n').slice(-12),
        continuity: continuityInfo(),
      },
    }), { text: has('--text'), summary: has('--summary') });
  }

  // 2b. PASSOU → entrega: marca `done`, grava no ledger, constrói a SEGUINTE indexada.
  // Cabeça da fila — a MESMA que o gate de saúde aponta, para o fluxo não divergir.
  // (`next --from <id>` continua disponível para pedir a sucessora de uma issue específica.)
  const next = buildNextIssueInstruction(tasks);
  if (!dryRun) {
    for (const phase of roadmap.phases) {
      for (const raw of phase.tasks) {
        if (raw.id === task.id) {
          raw.status = 'done';
          raw.evidence = `${headSha().slice(0, 7)}: ${task.verify} → 0 (pipeline ${at})`;
        }
      }
    }
    writeJson('.kiro/state/roadmap.json', roadmap, root);

    const ledger = openLedger();
    if (ledger.repos) {
      recordGate(ledger.repos, { id: `task:${task.id}`, ok: true, detail: `${task.verify} → 0`, branch: currentBranch() });
      recordEvent(ledger.repos, { type: 'pipeline', summary: `${task.id} concluída e testada — próxima: ${next?.id ?? 'fila vazia'}`, branch: currentBranch(), data: { task: task.id, verify: task.verify, next: next?.id ?? null } });
    }
  }

  if (next && has('--emit')) {
    attachments.push(writeArtifact(`${PIPELINE_DIR}/next-${next.id}.md`, renderInstructionMd(next, {
      branch: currentBranch(), headSha: headSha(), at, verdict: 'task-complete',
    })));
  }

  const result: ActionResult = makeResult({
    action,
    status: 'success',
    message: `${task.id} testada e entregue (\`${task.verify}\` → 0)${dryRun ? ' [dry-run: roadmap e ledger não foram tocados]' : ''}${next ? ` — próxima issue: ${next.id}` : ' — fila vazia'}`,
    attachments,
    nextIssue: next,
    at,
    details: { task: task.id, command: task.verify, dryRun, roadmapUpdated: !dryRun },
  });
  return emitResult(result, { text: has('--text'), summary: has('--summary') });
}

// ─── main ────────────────────────────────────────────────────────────────────

function main(): number {
  switch (command) {
    case 'health': return cmdHealth();
    case 'next': return cmdNext();
    case 'complete': return cmdComplete();
    case 'tasks': {
      // utilitário de inspeção: a fila como JSON (mesmo contrato)
      try {
        const tasks = pipelineTasks(loadRoadmap(root));
        const open = tasks.filter(t => t.status !== 'done');
        return emitResult(makeResult({ action: 'tasks', status: 'success', message: `${open.length} aberta(s) de ${tasks.length}`, details: { open: open.map(t => ({ id: t.id, phase: t.phase, title: t.title, verify: t.verify ?? null })) } }), { text: has('--text') });
      } catch (error) {
        return emitResult(makeResult({ action: 'tasks', status: 'error', message: (error as Error).message }), { text: has('--text') });
      }
    }
    default:
      process.stdout.write(`${HELP}\n`);
      return command === 'help' || command === '--help' ? 0 : 2;
  }
}

process.exitCode = main();
