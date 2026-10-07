#!/usr/bin/env -S npx tsx
/**
 * Continuity CLI — keeps the project state, scope and resume point in sync.
 *
 *   npm run continuity:status    # resumo do estado atual
 *   npm run continuity:sync      # mede invariantes, atualiza projeto-estado (STATE.md/RESUME.md)
 *   npm run continuity:check     # GATE: coerência de escopo/estado (usado no CI)
 *   npm run continuity:start     # cria/atualiza o handoff desta branch
 *   npm run continuity:resume    # briefing de retomada para a próxima sessão
 *
 * Spec: .kiro/specs/17-continuity-gate.md
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  RESUME_FILE,
  STATE_FILE,
  STATE_MD_FILE,
  buildState,
  checkPhaseDiscipline,
  checkScope,
  computeNextTasks,
  evaluateKernelFreshness,
  computeOverall,
  computePhaseProgress,
  currentPhase,
  loadHandoff,
  listHandoffs,
  loadPolicy,
  loadRoadmap,
  loadState,
  matchesAny,
  renderResumeMd,
  renderStateMd,
  saveHandoff,
  slugifyBranch,
  taskIndex,
  validateHandoff,
  validateRoadmap,
  writeJson,
  type Finding,
  type GateResult,
  type Handoff,
  type Metrics,
  type ProjectState,
} from './lib/continuity-core.js';

const root = process.cwd();
const args = process.argv.slice(2);
const command = args[0] ?? 'status';

const flag = (...names: string[]): string | undefined => {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  }
  return undefined;
};
const has = (...names: string[]): boolean => names.some(name => args.includes(name));

const C = {
  dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', bold: '\x1b[1m', reset: '\x1b[0m',
};
const icon = (level: Finding['level']) => (level === 'error' ? `${C.red}✗${C.reset}` : level === 'warn' ? `${C.yellow}!${C.reset}` : `${C.blue}i${C.reset}`);

// ─── git helpers ─────────────────────────────────────────────────────────────

function git(command: string, fallback = ''): string {
  try {
    return execFileSync('git', command.split(' '), { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function gitOk(command: string): boolean {
  try {
    execFileSync('git', command.split(' '), { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const currentBranch = (): string => flag('--branch') ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? git('rev-parse --abbrev-ref HEAD', 'HEAD');
const headSha = (): string => git('rev-parse HEAD', 'unknown');

function changedFiles(base: string): string[] {
  const baseRef = flag('--base-ref') ?? base;
  const mergeBase = git(`merge-base ${baseRef} HEAD`) || baseRef;
  return git(`diff --name-only --diff-filter=ACMR ${mergeBase}...HEAD`).split('\n').filter(Boolean);
}

/** Files changed after the last state sync — used to detect unverified kernel edits. */
function changedSinceState(state: ProjectState | null): string[] {
  if (!state?.headSha) return [];
  if (!gitOk(`cat-file -e ${state.headSha}^{commit}`)) return [];
  if (git(`rev-parse ${state.headSha}`) === headSha()) return [];
  if (!gitOk(`merge-base --is-ancestor ${state.headSha} HEAD`)) return [];
  return git(`diff --name-only ${state.headSha}..HEAD`).split('\n').filter(Boolean);
}

// ─── command: sync ───────────────────────────────────────────────────────────

interface CommandRun { id: string; command: string; ok: boolean; output: string }

function run(id: string, command: string, timeoutMs = 900_000): CommandRun {
  process.stdout.write(`${C.dim}· ${id}: ${command}${C.reset}\n`);
  try {
    const output = execSync(command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    return { id, command, ok: true, output };
  } catch (error) {
    const anyError = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output = `${anyError.stdout ?? ''}${anyError.stderr ?? ''}`;
    return { id, command, ok: false, output: String(output) };
  }
}

function collectMetrics(options: { fast: boolean; pages: boolean }): { metrics: Metrics; gates: GateResult[] } {
  const now = new Date().toISOString();
  const metrics: Metrics = { generatedAt: now, stale: options.fast };
  const gates: GateResult[] = [];

  // wasm artifacts + verification (cheap and always required)
  const manifestPath = path.join(root, 'public', 'wasm', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { kernelBytes: number; wasiBytes: number };
    metrics.wasmKernelBytes = manifest.kernelBytes;
    metrics.wasiBytes = manifest.wasiBytes;
  }

  const wasmVerify = run('wasm-verify', 'npm run --silent wasm:verify');
  const checks = (wasmVerify.output.match(/✓/g) ?? []).length;
  metrics.wasmChecks = checks;
  gates.push({
    id: 'wasm-verify',
    ok: wasmVerify.ok,
    detail: wasmVerify.ok ? `${checks} verificações ok` : 'falhou',
    ranAt: now,
  });

  const docker = run('docker-static', 'npm run --silent deploy:docker');
  metrics.dockerChecks = (docker.output.match(/✓/g) ?? []).length;
  gates.push({
    id: 'docker-static',
    ok: docker.ok,
    detail: docker.ok ? `${metrics.dockerChecks} validações estáticas` : 'falhou',
    ranAt: now,
  });

  if (!options.fast) {
    const tests = run('tests', 'npm test');
    const passed = /Tests\s+(\d+) passed/.exec(tests.output);
    const files = /Test Files\s+(\d+) passed/.exec(tests.output);
    metrics.testsPassed = passed ? Number(passed[1]) : undefined;
    metrics.testFiles = files ? Number(files[1]) : undefined;
    gates.push({ id: 'tests', ok: tests.ok, detail: tests.ok ? `${metrics.testsPassed ?? '?'} testes / ${metrics.testFiles ?? '?'} arquivos` : 'falhou', ranAt: now });

    const build = run('build', 'npm run build');
    metrics.buildOk = build.ok;
    const bundle = /index-[\w-]+\.js\s+([\d.,]+)\s*kB/.exec(build.output);
    if (bundle) metrics.bundleKb = Number(bundle[1].replace(',', ''));
    gates.push({ id: 'build', ok: build.ok, detail: build.ok ? `bundle principal ${metrics.bundleKb ?? '?'} kB` : 'falhou', ranAt: now });

    const lint = run('lint', 'npm run lint');
    const lintMatch = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(lint.output);
    if (lintMatch) {
      metrics.lintProblems = Number(lintMatch[1]);
      metrics.lintErrors = Number(lintMatch[2]);
      metrics.lintWarnings = Number(lintMatch[3]);
    }
    gates.push({
      id: 'lint',
      ok: (metrics.lintErrors ?? 0) === 0,
      detail: `${metrics.lintErrors ?? '?'} erros / ${metrics.lintWarnings ?? '?'} avisos`,
      ranAt: now,
    });
  }

  if (options.pages) {
    const pages = run('pages-artifact', 'node scripts/build-pages-artifact.mjs --env all --out _site', 1_200_000);
    const envs = ['production', 'staging', 'dev'].filter(env => fs.existsSync(path.join(root, '_site', env === 'production' ? 'index.html' : `${env}/index.html`)));
    metrics.pagesEnvs = envs;
    gates.push({ id: 'pages-artifact', ok: pages.ok && envs.length === 3, detail: `${envs.length}/3 ambientes`, ranAt: now });
  }

  return { metrics, gates };
}

async function cmdSync(): Promise<number> {
  const fast = has('--fast');
  const pages = has('--pages');
  const write = !has('--no-write');

  const roadmap = loadRoadmap(root);
  const policy = loadPolicy(root);
  const branch = currentBranch();

  const { metrics, gates } = collectMetrics({ fast, pages });
  const state = buildState({ roadmap, policy, branch, headSha: headSha(), metrics, gates });
  const handoff = loadHandoff(branch, root);
  const commits = git('log --oneline -5').split('\n').filter(Boolean);

  if (write) {
    writeJson(STATE_FILE, state, root);
    fs.writeFileSync(path.join(root, STATE_MD_FILE), renderStateMd(state));
    fs.writeFileSync(path.join(root, RESUME_FILE), renderResumeMd({ state, roadmap, handoff, recentCommits: commits }));
    // public/state.json ships with the page (Runtime page shows the phase)
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'public', 'state.json'),
      `${JSON.stringify({
        generatedAt: state.generatedAt,
        phase: state.currentPhase,
        phaseName: state.currentPhaseName,
        percent: state.overall.percent,
        done: state.overall.done,
        total: state.overall.total,
        next: state.nextTasks.slice(0, 3).map(task => ({ id: task.id, title: task.title, blockedBy: task.blockedBy })),
        invariants: state.invariants,
      }, null, 2)}\n`,
    );
    process.stdout.write(`${C.green}✓${C.reset} estado atualizado: ${STATE_FILE}, ${STATE_MD_FILE}, ${RESUME_FILE}, public/state.json\n`);
  }

  process.stdout.write(`\n${C.bold}Estado do projeto${C.reset} — fase ${state.currentPhase} (${state.overall.percent}% · ${state.overall.done}/${state.overall.total})\n`);
  for (const gate of state.gates) {
    process.stdout.write(`  ${gate.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${gate.id.padEnd(14)} ${C.dim}${gate.detail}${C.reset}\n`);
  }
  process.stdout.write(`\nPróximas tarefas: ${state.nextTasks.map(task => task.id).join(', ') || '—'}\n\n`);

  const failing = state.gates.filter(gate => !gate.ok && !['lint'].includes(gate.id));
  return failing.length === 0 ? 0 : 1;
}

// ─── command: check (the gate) ───────────────────────────────────────────────

function cmdCheck(): number {
  const roadmap = loadRoadmap(root);
  const policy = loadPolicy(root);

  const branch = currentBranch();
  const base = flag('--base') ?? policy.baseBranch;
  const changed = flag('--files')?.split(',').filter(Boolean) ?? changedFiles(base);
  const state = loadState(root);
  const handoff = loadHandoff(branch, root);
  const allowLabel = has('--allow-label');
  const findings: Finding[] = [];

  const isProtected = policy.protectedBranches.includes(branch);

  // 1. roadmap self-consistency
  findings.push(...validateRoadmap(roadmap));
  findings.push(...checkPhaseDiscipline(roadmap));

  // 2. handoff presence + coherence (skipped on the branches that consolidate state)
  if (!handoff && !isProtected) {
    findings.push({
      level: 'error',
      code: 'missing-handoff',
      message: `a branch "${branch}" não tem handoff de escopo`,
      hint: `rode: npm run continuity:start -- --branch ${branch} --task <T-xxx> (ou deixe o workflow continuity-gate criar automaticamente)`,
    });
  } else if (handoff) {
    findings.push(...validateHandoff(handoff, roadmap, policy));

    // 3. scope enforcement against the diff
    const scope = checkScope(changed, handoff, policy, roadmap);
    if (scope.outOfScope.length) {
      findings.push({
        level: allowLabel ? 'warn' : 'error',
        code: 'scope-violation',
        message: `${scope.outOfScope.length} arquivo(s) fora do escopo declarado: ${scope.outOfScope.slice(0, 8).join(', ')}${scope.outOfScope.length > 8 ? ' …' : ''}`,
        hint: allowLabel
          ? `label "${policy.scopeAllowLabel}" presente — aceito como expansão de escopo; atualize o handoff e o roadmap`
          : `declare a tarefa/paths no handoff (npm run continuity:start) ou adicione a label "${policy.scopeAllowLabel}" para expansão intencional`,
      });
    }

    // 4. declared tasks must exist and be reflected in the roadmap status
    const index = taskIndex(roadmap);
    for (const taskId of handoff.scope.tasks) {
      const task = index.get(taskId);
      if (!task) continue;
      if (handoff.status === 'done' && task.status !== 'done') {
        findings.push({
          level: 'error',
          code: 'roadmap-not-updated',
          message: `handoff marca a branch como done, mas a tarefa ${taskId} continua "${task.status}" no roadmap`,
          hint: 'atualize .kiro/state/roadmap.json (status + evidence) junto com o código',
        });
      }
      if (task.status === 'done' && !task.evidence) {
        findings.push({ level: 'warn', code: 'done-without-evidence', message: `tarefa ${taskId} concluída sem 'evidence'` });
      }
    }
  }

  // 5. kernel freshness: a wasm/formula change must come with a state sync
  const kernelTouched = changed.filter(file => matchesAny(file, policy.kernelPaths));
  const kernelSinceState = changedSinceState(state).filter(file => matchesAny(file, policy.kernelPaths));
  const stateUpdatedInDiff = changed.some(file => matchesAny(file, [STATE_FILE]));
  findings.push(...evaluateKernelFreshness({ kernelTouched, kernelSinceState, stateUpdatedInDiff }));

  // 6. state freshness
  if (!state) {
    findings.push({ level: 'warn', code: 'missing-state', message: 'project-state.json ausente', hint: 'rode npm run continuity:sync' });
  } else if (state.headSha !== headSha()) {
    const drift = Number(git(`rev-list --count ${state.headSha}..HEAD`, '0') || 0);
    if (drift > policy.maxStateAgeCommits) {
      findings.push({ level: 'warn', code: 'stale-state', message: `estado com ${drift} commits de atraso`, hint: 'rode npm run continuity:sync' });
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const errors = findings.filter(f => f.level === 'error');
  const warnings = findings.filter(f => f.level === 'warn');
  const infos = findings.filter(f => f.level === 'info');

  if (has('--json')) {
    const report = { ok: errors.length === 0, branch, base, changedFiles: changed.length, handoff: handoff ? handoff.branch : null, findings, summary: { errors: errors.length, warnings: warnings.length, infos: infos.length } };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  process.stdout.write(`\n${C.bold}Gate de continuidade${C.reset} ${C.dim}· branch ${branch} · base ${base} · ${changed.length} arquivo(s) alterado(s)${C.reset}\n\n`);
  if (handoff) {
    process.stdout.write(`${C.dim}escopo:${C.reset} tarefas ${handoff.scope.tasks.join(', ') || '—'} · specs ${handoff.scope.specs.join(', ') || '—'} · ${handoff.scope.paths.length} glob(s) de caminho\n`);
    process.stdout.write(`${C.dim}retomada:${C.reset} ${handoff.resumePoint.summary}\n\n`);
  }
  for (const finding of [...errors, ...warnings, ...infos]) {
    process.stdout.write(`  ${icon(finding.level)} ${finding.code}: ${finding.message}\n`);
    if (finding.hint) process.stdout.write(`      ${C.dim}↳ ${finding.hint}${C.reset}\n`);
  }
  process.stdout.write(
    errors.length === 0
      ? `\n${C.green}✓ continuidade ok${C.reset} ${C.dim}(${warnings.length} aviso(s), ${infos.length} info)${C.reset}\n\n`
      : `\n${C.red}✗ ${errors.length} problema(s) de continuidade${C.reset}\n\n`,
  );
  return errors.length === 0 ? 0 : 1;
}

// ─── command: start (handoff scaffold) ───────────────────────────────────────

function inferScopeFromBranch(branch: string, roadmap: ReturnType<typeof loadRoadmap>) {
  const haystack = branch.toLowerCase();
  const tasks = roadmap.phases.flatMap(phase => phase.tasks).filter(task => {
    const words = `${task.id} ${task.title} ${task.spec ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3);
    return words.some(word => haystack.includes(word));
  });
  const specs = [...new Set(tasks.map(task => task.spec).filter((spec): spec is string => Boolean(spec)))];
  const paths = [...new Set(tasks.flatMap(task => task.paths ?? []))];
  return { tasks: tasks.map(task => task.id), specs, paths };
}

function cmdStart(): number {
  const roadmap = loadRoadmap(root);
  const policy = loadPolicy(root);
  const branch = flag('--branch') ?? currentBranch();
  const auto = has('--auto');
  const now = new Date().toISOString();

  const existing = loadHandoff(branch, root);
  const requestedTasks = flag('--task')?.split(',').filter(Boolean) ?? [];
  const requestedSpecs = flag('--spec')?.split(',').filter(Boolean) ?? [];
  const requestedPaths = flag('--paths')?.split(',').filter(Boolean) ?? [];

  const inferred = auto || requestedTasks.length === 0 ? inferScopeFromBranch(branch, roadmap) : { tasks: [], specs: [], paths: [] };
  const index = taskIndex(roadmap);
  const tasks = [...new Set([...requestedTasks, ...inferred.tasks])].filter(id => index.has(id));
  const taskPaths = tasks.flatMap(id => index.get(id)?.paths ?? []);
  const specs = [...new Set([...requestedSpecs, ...inferred.specs])];
  const paths = [...new Set([...requestedPaths, ...inferred.paths, ...taskPaths, ...specs.flatMap(spec => policy.scopes[spec] ?? [])])];

  const handoff: Handoff = existing
    ? {
        ...existing,
        updatedAt: now,
        scope: { specs: [...new Set([...existing.scope.specs, ...specs])], tasks: [...new Set([...existing.scope.tasks, ...tasks])], paths: [...new Set([...existing.scope.paths, ...paths])] },
        history: [...existing.history, { at: now, event: 'scope-updated', note: `tasks=[${tasks.join(',')}] specs=[${specs.join(',')}]` }],
      }
    : {
        schema: 1,
        branch,
        base: policy.baseBranch,
        createdAt: now,
        updatedAt: now,
        status: 'in_progress',
        scope: { specs, tasks, paths },
        resumePoint: {
          summary: tasks.length
            ? `Trabalho em ${tasks.join(', ')} (${tasks.map(id => index.get(id)?.title).filter(Boolean).join('; ')})`
            : 'Escopo ainda não detalhado — descreva aqui o objetivo desta branch.',
          next: tasks.flatMap(id => {
            const task = index.get(id);
            return task?.verify ? [`${id}: rodar \`${task.verify}\` e registrar evidência`] : [];
          }),
          blockedBy: tasks.flatMap(id => (index.get(id)?.dependsOn ?? []).filter(dep => index.get(dep)?.status !== 'done').map(dep => `${id} depende de ${dep}`)),
        },
        history: [{ at: now, event: 'created', note: auto ? 'handoff criado automaticamente pelo gate de continuidade' : 'handoff criado manualmente' }],
      };

  const file = saveHandoff(handoff, root);
  process.stdout.write(`${C.green}✓${C.reset} handoff ${existing ? 'atualizado' : 'criado'}: ${file}\n`);
  process.stdout.write(`  tarefas: ${handoff.scope.tasks.join(', ') || '—'}\n  specs:   ${handoff.scope.specs.join(', ') || '—'}\n  paths:   ${handoff.scope.paths.length} glob(s)\n`);
  if (!handoff.scope.tasks.length) {
    process.stdout.write(`  ${C.yellow}!${C.reset} nenhum escopo inferido — ajuste o arquivo ou rode com ${C.bold}--task T-xxx${C.reset}\n`);
  }
  return 0;
}

// ─── command: resume / status ────────────────────────────────────────────────

function cmdResume(): number {
  const roadmap = loadRoadmap(root);
  const policy = loadPolicy(root);
  const state = loadState(root);
  const branch = currentBranch();
  const handoff = loadHandoff(branch, root);
  const commits = git('log --oneline -5').split('\n').filter(Boolean);

  const effective =
    state ??
    buildState({ roadmap, policy, branch, headSha: headSha(), metrics: { stale: true }, gates: [] });
  const markdown = renderResumeMd({ state: effective, roadmap, handoff, recentCommits: commits });

  if (!has('--print') && !has('--no-write')) {
    fs.writeFileSync(path.join(root, RESUME_FILE), markdown);
  }
  process.stdout.write(markdown);
  return 0;
}

function cmdStatus(): number {
  const roadmap = loadRoadmap(root);
  const state = loadState(root);
  const phase = currentPhase(roadmap);
  const overall = computeOverall(roadmap);

  process.stdout.write(`\n${C.bold}${roadmap.project}${C.reset} ${C.dim}v${roadmap.version}${C.reset}\n`);
  process.stdout.write(`${C.dim}estado:${C.reset} ${state ? `${state.generatedAt} @ ${state.headSha.slice(0, 7)}` : 'não sincronizado (npm run continuity:sync)'}\n\n`);
  process.stdout.write(`fase atual: ${C.bold}${phase.id}${C.reset} — ${phase.name}\n`);
  process.stdout.write(`progresso:  ${overall.done}/${overall.total} tarefas (${overall.percent}%)\n\n`);

  for (const progress of computePhaseProgress(roadmap)) {
    const bar = '█'.repeat(Math.round(progress.percent / 10)).padEnd(10, '·');
    process.stdout.write(`  ${progress.id} ${bar} ${String(progress.percent).padStart(3)}%  ${progress.name}${progress.open.length ? C.dim + ` (aberto: ${progress.open.slice(0, 4).join(', ')}${progress.open.length > 4 ? '…' : ''})` + C.reset : ''}\n`);
  }

  const next = computeNextTasks(roadmap, 5);
  process.stdout.write(`\npróximas tarefas:\n`);
  for (const task of next) {
    process.stdout.write(`  · ${C.bold}${task.id}${C.reset} ${task.title}${task.blockedBy.length ? ` ${C.yellow}[bloqueado: ${task.blockedBy.join(', ')}]${C.reset}` : ''}\n`);
    if (task.verify) process.stdout.write(`      ${C.dim}aceite: ${task.verify}${C.reset}\n`);
  }
  process.stdout.write('');

  const handoffs = listHandoffs(root);
  if (handoffs.length) {
    process.stdout.write(`\nbranches com escopo declarado:\n`);
    for (const { handoff } of handoffs.slice(0, 8)) {
      process.stdout.write(`  · ${handoff.branch} — ${handoff.scope.tasks.join(', ') || 'sem tarefas'} ${C.dim}(${handoff.updatedAt.slice(0, 10)})${C.reset}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, () => number | Promise<number>> = {
  status: cmdStatus,
  check: cmdCheck,
  start: cmdStart,
  resume: cmdResume,
  sync: cmdSync,
};

async function main(): Promise<void> {
  if (has('--help', '-h') || !(command in COMMANDS)) {
    process.stdout.write(`
${C.bold}continuity${C.reset} — estado, escopo e retomada do projeto

  npm run continuity:status                 resumo do roadmap e da fase atual
  npm run continuity:sync [--fast] [--pages]  mede invariantes e grava o estado
  npm run continuity:check [--base main] [--json]  GATE de continuidade
  npm run continuity:start [--task T-xxx] [--auto]  cria o handoff da branch
  npm run continuity:resume                 briefing de retomada

Arquivos: .kiro/state/{roadmap,policy,project-state}.json · STATE.md · RESUME.md · branches/<slug>.json
`);
    process.exit(command in COMMANDS ? 0 : 1);
  }
  const exitCode = await COMMANDS[command]();
  process.exit(exitCode);
}

void main();
