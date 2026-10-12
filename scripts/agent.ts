#!/usr/bin/env -S npx tsx
/**
 * Agent API — the GitOps actions a session (human or agent) can dispatch.
 *
 * The point is continuity **without a personal credential**: every action runs
 * with the token the environment already has — the ephemeral `GITHUB_TOKEN` of a
 * workflow run, or the `gh auth` of a session (an app installation, never a PAT
 * stored in the repo). Nothing here reads, saves or prints a credential; `gh`
 * picks the token from the environment.
 *
 *   npm run agent -- status
 *   npm run agent -- audit [--limit 20]
 *   npm run agent -- resume [--pr 1 --post]
 *   npm run agent -- check [--base main]
 *   npm run agent -- deploy --ref <branch> --environments dev,staging
 *   npm run agent -- bootstrap [--protect-main]
 *   npm run agent -- sync
 *
 * Universal flags: --dry-run (mostra o que faria, sem tocar na API) · --json ·
 * --summary (escreve markdown no $GITHUB_STEP_SUMMARY, para a run ficar auditável)
 *
 * Spec: .kiro/specs/17-continuity-gate.md (Requirement 11)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_FILE, type Snapshot } from './lib/store-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };

// ─── Args (pure, testable) ───────────────────────────────────────────────────

export const AGENT_ACTIONS = ['status', 'audit', 'resume', 'check', 'deploy', 'bootstrap', 'sync'] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface AgentArgs {
  action: AgentAction;
  ref: string;
  environments: string;
  pr: number | null;
  base: string;
  limit: number;
  protectMain: boolean;
  dryRun: boolean;
  json: boolean;
  summary: boolean;
  post: boolean;
}

export const AGENT_USAGE = `agent — ações de GitOps/continuidade via API (sem credencial pessoal)

  status                              onde o projeto está (fase, %, próximas, bloqueios)
  audit                               auditoria do ledger: gates com falha, sessões, eventos
  resume [--pr <n>] [--post]          briefing de retomada; com --post, publica no PR
  check [--base main]                 roda o gate de continuidade
  deploy --ref <branch> --environments dev,staging   dispara o deploy de Pages
  bootstrap [--protect-main]          cria dev/staging (+ proteção) via API
  sync                                dispara a consolidação de estado na main

Flags: --dry-run · --json · --summary · --limit N`;

export function parseAgentArgs(argv: string[]): AgentArgs {
  const [action, ...rest] = argv;
  if (!AGENT_ACTIONS.includes(action as AgentAction)) {
    throw new Error(`ação desconhecida: "${action ?? ''}" (use: ${AGENT_ACTIONS.join(' | ')})`);
  }
  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const has = (name: string): boolean => rest.includes(name);
  const pr = flag('--pr');
  const environments = (flag('--environments') ?? 'all').split(',').map(value => value.trim()).filter(Boolean);
  const allowed = new Set(['all', 'production', 'staging', 'dev']);
  for (const environment of environments) {
    if (!allowed.has(environment)) throw new Error(`ambiente inválido: "${environment}" (use: all | production | staging | dev)`);
  }
  const ref = (flag('--ref') ?? '').trim();
  if (action === 'deploy' && ref) {
    // um ref só pode ser branch existente ou SHA — nunca um caminho
    if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) throw new Error(`ref inválido: "${ref}"`);
  }
  return {
    action: action as AgentAction,
    ref,
    environments: environments.join(','),
    pr: pr ? Number(pr) : null,
    base: flag('--base') ?? 'main',
    limit: Number(flag('--limit') ?? 20),
    protectMain: has('--protect-main'),
    dryRun: has('--dry-run'),
    json: has('--json'),
    summary: has('--summary'),
    post: has('--post'),
  };
}

// ─── Shell helpers ───────────────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  output: string;
}

function sh(command: string, argv: string[], options: { dry?: boolean; allowFailure?: boolean } = {}): RunResult {
  if (options.dry) return { ok: true, output: `[dry-run] ${command} ${argv.join(' ')}` };
  try {
    const output = execFileSync(command, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || failure.message;
    if (options.allowFailure) return { ok: false, output };
    throw new Error(`${command} ${argv.slice(0, 3).join(' ')} falhou: ${output.slice(0, 400)}`);
  }
}

// ─── Audit (pure) ────────────────────────────────────────────────────────────

export interface AuditReport {
  generatedAt: string;
  collections: Record<string, number>;
  gates: {
    /** Execuções registradas (histórico completo). */
    total: number;
    /** Quantas dessas execuções falharam — histórico, não veredito. */
    failedRuns: number;
    /** Última execução de cada gate cujo resultado foi falha. */
    failing: { id: string; detail: string; ran_at: string }[];
    /** `true` quando a última execução de todos os gates passou. */
    ok: boolean;
  };
  lastSession: { id: string; branch: string; goal: string; resume_point: string; blockers: string[]; heartbeat_at: string } | null;
  recentEvents: { at: string; type: string; summary: string }[];
  stale: boolean;
}

export function summarizeAudit(snapshot: Snapshot, headSha: string, limit = 20): AuditReport {
  const gates = snapshot.tables.gates ?? [];
  const failedRuns = gates.filter(gate => gate.ok === false);

  // Veredito = última execução de cada gate (id no formato `<gate>@<timestamp>`);
  // falhas antigas já corrigidas continuam no histórico, mas não reprovam a auditoria.
  const latestOf = new Map<string, Record<string, unknown>>();
  for (const gate of gates) {
    const name = String(gate.id ?? '').split('@')[0];
    const current = latestOf.get(name);
    if (!current || String(gate.ran_at ?? '') > String(current.ran_at ?? '')) latestOf.set(name, gate);
  }
  const failing = [...latestOf.values()].filter(gate => gate.ok === false);

  const sessions = snapshot.tables.sessions ?? [];
  const events = (snapshot.tables.events ?? []).slice(0, limit);
  const lastSync = (snapshot.tables.kv ?? []).find(row => row.key === 'last_sync')?.value as { commit?: string } | undefined;
  return {
    generatedAt: snapshot.generatedAt,
    collections: snapshot.counts ?? {},
    gates: {
      total: gates.length,
      failedRuns: failedRuns.length,
      failing: failing.slice(0, 10).map(gate => ({ id: String(gate.id), detail: String(gate.detail ?? ''), ran_at: String(gate.ran_at ?? '') })),
      ok: failing.length === 0,
    },
    lastSession: sessions[0]
      ? {
          id: String(sessions[0].id),
          branch: String(sessions[0].branch ?? ''),
          goal: String(sessions[0].goal ?? ''),
          resume_point: String(sessions[0].resume_point ?? ''),
          blockers: (sessions[0].blockers as string[]) ?? [],
          heartbeat_at: String(sessions[0].heartbeat_at ?? ''),
        }
      : null,
    recentEvents: events.map(event => ({ at: String(event.at ?? ''), type: String(event.type ?? ''), summary: String(event.summary ?? '') })),
    stale: Boolean(headSha && lastSync?.commit && !headSha.startsWith(String(lastSync.commit).slice(0, 7))),
  };
}

export function renderAuditMd(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`## 🧾 Auditoria do ledger`);
  lines.push('');
  lines.push(`- snapshot: \`${report.generatedAt}\`${report.stale ? ' · **atrás do HEAD** (rode `npm run continuity:sync`)' : ''}`);
  lines.push(`- coleções: ${Object.entries(report.collections).map(([table, count]) => `${table}=${count}`).join(' · ')}`);
  lines.push(`- gates registrados: **${report.gates.total}** (${report.gates.failedRuns} execução(ões) com falha no histórico)`);
  lines.push(`- veredito pela última execução de cada gate: ${report.gates.ok ? '**tudo verde**' : '**há gate vermelho**'}`);
  for (const gate of report.gates.failing) lines.push(`  - ✗ \`${gate.id}\` — ${gate.detail} (${gate.ran_at})`);
  if (report.lastSession) {
    lines.push('');
    lines.push(`### Sessão mais recente — \`${report.lastSession.id}\``);
    lines.push(`- branch: \`${report.lastSession.branch}\` · heartbeat: ${report.lastSession.heartbeat_at}`);
    if (report.lastSession.goal) lines.push(`- objetivo: ${report.lastSession.goal}`);
    if (report.lastSession.resume_point) lines.push(`- retomada: ${report.lastSession.resume_point}`);
    if (report.lastSession.blockers.length) lines.push(`- bloqueios: ${report.lastSession.blockers.join('; ')}`);
  }
  if (report.recentEvents.length) {
    lines.push('');
    lines.push('### Eventos recentes');
    for (const event of report.recentEvents.slice(0, 8)) lines.push(`- \`${event.at}\` **${event.type}** — ${event.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resumeCommentBody(resumeMd: string, actor: string, runUrl?: string): string {
  const head = ['<!-- agent-resume -->', `## 🧭 Retomada (agente)`, '', `_pedido por \`${actor}\`${runUrl ? ` · [run](${runUrl})` : ''}_`, ''].join('\n');
  return `${head}\n${resumeMd.trim()}\n`;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function readSnapshot(): Snapshot | null {
  const file = path.join(root, SNAPSHOT_FILE);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot) : null;
}

function headSha(): string {
  const result = sh('git', ['rev-parse', 'HEAD'], { allowFailure: true });
  return result.ok ? result.output : '';
}

function emit(text: string, args: AgentArgs, payload?: unknown): void {
  if (args.json && payload !== undefined) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  if (args.summary && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text.startsWith('#') ? `${text}\n` : `\`\`\`\n${text}\n\`\`\`\n`);
  }
}

function actionStatus(args: AgentArgs): number {
  const result = sh('npx', ['tsx', 'scripts/continuity.ts', 'status'], { allowFailure: true });
  if (!result.ok) throw new Error(result.output);
  emit(result.output, args, { status: result.output });
  return 0;
}

function actionAudit(args: AgentArgs): number {
  const snapshot = readSnapshot();
  if (!snapshot) throw new Error(`${SNAPSHOT_FILE} não existe — rode \`npm run continuity:sync\` (ou \`npm run store -- export\`)`);
  const report = summarizeAudit(snapshot, headSha(), args.limit);
  emit(renderAuditMd(report), args, report);
  // Reprova quando a última execução de algum gate falhou. Histórico de falhas já
  // corrigidas aparece no relatório sem derrubar o comando, e snapshot atrás do HEAD
  // é aviso: o estado é regenerado a cada sync (o CI consolida no main), então usar
  // defasagem como erro faria todo commit recém-feito reprovar a auditoria.
  return report.gates.ok ? 0 : 1;
}

function actionCheck(args: AgentArgs): number {
  const result = sh('npx', ['tsx', 'scripts/continuity.ts', 'check', '--base', args.base], { allowFailure: true });
  emit(result.output, args, { ok: result.ok, base: args.base, output: result.output });
  return result.ok ? 0 : 1;
}

function actionResume(args: AgentArgs): number {
  const file = path.join(root, '.kiro/state/RESUME.md');
  if (!fs.existsSync(file)) throw new Error('.kiro/state/RESUME.md não existe — rode `npm run continuity:sync`');
  const resumeMd = fs.readFileSync(file, 'utf8');
  emit(resumeMd, args, { resume: resumeMd });

  if (args.pr && args.post) {
    // o repo sai do remoto local — uma leitura de API a menos
    const remote = sh('git', ['remote', 'get-url', 'origin'], { allowFailure: true }).output;
    const repo = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote)?.[1] ?? '';
    if (!repo) throw new Error('remoto origin não parece um repositório do GitHub');

    const marker = '<!-- agent-resume -->';
    const body = resumeCommentBody(resumeMd, process.env.GITHUB_ACTOR ?? process.env.USER ?? 'agent', process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined);
    const bodyFile = path.join(root, 'agent-resume-comment.md');
    fs.writeFileSync(bodyFile, body);
    const relativeBody = path.relative(root, bodyFile);

    if (args.dryRun) {
      process.stdout.write(`${C.dim}[dry-run] gh api repos/${repo}/issues/${args.pr}/comments --jq 'select ${marker}'  → decide POST/PATCH${C.reset}\n`);
      process.stdout.write(`${C.dim}[dry-run] gh api --method POST|PATCH repos/${repo}/issues[/comments]/… -F body=@${relativeBody}  (${body.length} bytes)${C.reset}\n`);
    } else {
      const existing = sh('gh', ['api', `repos/${repo}/issues/${args.pr}/comments`, '--jq', `.[] | select(.body | startswith("${marker}")) | .id`], { allowFailure: true });
      const previous = existing.output.split('\n').filter(Boolean)[0];
      const endpoint = previous ? `repos/${repo}/issues/comments/${previous}` : `repos/${repo}/issues/${args.pr}/comments`;
      sh('gh', ['api', '--method', previous ? 'PATCH' : 'POST', endpoint, '-F', `body=@${relativeBody}`]);
      process.stdout.write(`${C.green}✓${C.reset} briefing ${previous ? 'atualizado' : 'publicado'} no PR #${args.pr}\n`);
    }
  } else if (args.pr && !args.post) {
    process.stdout.write(`${C.dim}· --pr sem --post: nada publicado${C.reset}\n`);
  }
  return 0;
}

function actionDeploy(args: AgentArgs): number {
  const argv = ['workflow', 'run', 'deploy-pages.yml'];
  if (args.ref) argv.push('-f', `ref=${args.ref}`);
  argv.push('-f', `environments=${args.environments}`);
  const result = sh('gh', argv, { dry: args.dryRun });
  emit(`${result.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} deploy disparado: ${args.environments}${args.ref ? ` a partir de ${args.ref}` : ''}\n${result.output}`, args, { action: 'deploy', ref: args.ref, environments: args.environments, dryRun: args.dryRun, output: result.output });
  return result.ok ? 0 : 1;
}

function actionBootstrap(args: AgentArgs): number {
  const argv = ['workflow', 'run', 'bootstrap-repo.yml'];
  if (args.protectMain) argv.push('-f', 'protect_main=true');
  const result = sh('gh', argv, { dry: args.dryRun });
  emit(`${result.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} bootstrap disparado${args.protectMain ? ' (com proteção da main)' : ''}\n${result.output}`, args, { action: 'bootstrap', protectMain: args.protectMain, dryRun: args.dryRun, output: result.output });
  return result.ok ? 0 : 1;
}

function actionSync(args: AgentArgs): number {
  const result = sh('gh', ['workflow', 'run', 'continuity-sync.yml'], { dry: args.dryRun });
  emit(`${result.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} consolidação de estado disparada\n${result.output}`, args, { action: 'sync', dryRun: args.dryRun, output: result.output });
  return result.ok ? 0 : 1;
}

// ─── main ────────────────────────────────────────────────────────────────────

const ACTIONS: Record<AgentAction, (args: AgentArgs) => number> = {
  status: actionStatus,
  audit: actionAudit,
  resume: actionResume,
  check: actionCheck,
  deploy: actionDeploy,
  bootstrap: actionBootstrap,
  sync: actionSync,
};

export function runAgent(argv: string[]): number {
  let args: AgentArgs;
  try {
    args = parseAgentArgs(argv);
  } catch (error) {
    process.stderr.write(`${C.red}✗${C.reset} ${(error as Error).message}\n\n${AGENT_USAGE}\n`);
    return 2;
  }
  try {
    return ACTIONS[args.action](args);
  } catch (error) {
    process.stderr.write(`${C.red}✗${C.reset} ${(error as Error).message}\n`);
    return 1;
  }
}

// executado só como CLI (os testes importam as funções puras)
if (/agent\.(ts|js|mjs)$/.test(process.argv[1] ?? '')) {
  process.exit(runAgent(process.argv.slice(2)));
}
