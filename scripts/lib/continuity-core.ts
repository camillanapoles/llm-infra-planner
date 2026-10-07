/**
 * Continuity core — project state, scope enforcement and resume briefs.
 *
 * Pure logic (no process/git/network side effects) so it can be unit-tested and
 * reused by both the local CLI (`scripts/continuity.ts`) and CI.
 *
 * Model (spec 17-continuity-gate.md):
 *
 *   roadmap.json ── fases, tarefas, dependências, escopo por caminho
 *   policy.json  ── regras do gate (shared paths, kernel paths, labels)
 *   branches/<slug>.json ── handoff: qual escopo ESTA branch se comprometeu a entregar
 *   project-state.json   ── estado DERIVADO (progresso, invariantes, gates)
 *
 * The gate refuses a PR when the branch does not carry a coherent handoff, when
 * the diff leaves the declared scope, or when the wasm kernel changed after the
 * last state sync (i.e. the change was not re-verified).
 */
import fs from 'node:fs';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export interface ExitCriterion {
  id: string;
  label: string;
  command?: string;
}

export interface RoadmapTask {
  id: string;
  title: string;
  status: TaskStatus;
  spec?: string;
  paths?: string[];
  verify?: string;
  dependsOn?: string[];
  crossPhase?: boolean;
  evidence?: string;
  notes?: string;
}

export interface RoadmapPhase {
  id: string;
  name: string;
  goal: string;
  status: TaskStatus;
  exitCriteria?: ExitCriterion[];
  tasks: RoadmapTask[];
}

export interface Roadmap {
  schema: number;
  project: string;
  version: string;
  updatedAt: string;
  notes?: string[];
  phases: RoadmapPhase[];
}

export interface Policy {
  schema: number;
  baseBranch: string;
  protectedBranches: string[];
  statePaths: string[];
  sharedPaths: string[];
  kernelPaths: string[];
  scopeAllowLabel: string;
  gateName: string;
  maxStateAgeCommits: number;
  scopes: Record<string, string[]>;
  resume?: { commands: string[]; guardrails: string[] };
}

export interface Handoff {
  schema: number;
  branch: string;
  base: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  scope: { specs: string[]; tasks: string[]; paths: string[] };
  resumePoint: { summary: string; next: string[]; blockedBy: string[] };
  history: { at: string; event: string; note: string }[];
}

export interface Finding {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  hint?: string;
}

export interface Metrics {
  commit?: string;
  generatedAt?: string;
  stale?: boolean;
  testsPassed?: number;
  testFiles?: number;
  wasmKernelBytes?: number;
  wasiBytes?: number;
  wasmChecks?: number;
  buildOk?: boolean;
  bundleKb?: number;
  lintProblems?: number;
  lintErrors?: number;
  lintWarnings?: number;
  dockerChecks?: number;
  pagesEnvs?: string[];
}

export interface GateResult {
  id: string;
  ok: boolean;
  detail: string;
  ranAt: string;
}

export interface NextTask {
  id: string;
  title: string;
  phase: string;
  phaseName: string;
  spec?: string;
  verify?: string;
  blockedBy: string[];
  notes?: string;
}

export interface PhaseProgress {
  id: string;
  name: string;
  status: TaskStatus;
  done: number;
  total: number;
  percent: number;
  open: string[];
}

export interface ProjectState {
  schema: number;
  project: string;
  generatedAt: string;
  branch: string;
  headSha: string;
  baseBranch: string;
  currentPhase: string;
  currentPhaseName: string;
  phaseProgress: PhaseProgress[];
  overall: { done: number; total: number; percent: number };
  nextTasks: NextTask[];
  invariants: Metrics;
  gates: GateResult[];
  resume: { summary: string; next: string[]; commands: string[]; guardrails: string[] };
}

export interface ScopeCheckResult {
  inScope: string[];
  shared: string[];
  state: string[];
  outOfScope: string[];
}

// ─── Paths & IO ──────────────────────────────────────────────────────────────

export const STATE_DIR = '.kiro/state';
export const ROADMAP_FILE = `${STATE_DIR}/roadmap.json`;
export const POLICY_FILE = `${STATE_DIR}/policy.json`;
export const STATE_FILE = `${STATE_DIR}/project-state.json`;
export const STATE_MD_FILE = `${STATE_DIR}/STATE.md`;
export const RESUME_FILE = `${STATE_DIR}/RESUME.md`;
export const HANDOFF_DIR = `${STATE_DIR}/branches`;

export function readJson<T>(file: string, root = process.cwd()): T | null {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown, root = process.cwd()): void {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

export const loadRoadmap = (root = process.cwd()): Roadmap => {
  const roadmap = readJson<Roadmap>(ROADMAP_FILE, root);
  if (!roadmap) throw new Error(`roadmap not found: ${ROADMAP_FILE}`);
  return roadmap;
};

export const loadPolicy = (root = process.cwd()): Policy => {
  const policy = readJson<Policy>(POLICY_FILE, root);
  if (!policy) throw new Error(`policy not found: ${POLICY_FILE}`);
  return policy;
};

export const loadState = (root = process.cwd()): ProjectState | null =>
  readJson<ProjectState>(STATE_FILE, root);

/** `arena/fe62ce6d-llm-infra-planner` → `arena-fe62ce6d-llm-infra-planner` */
export const slugifyBranch = (branch: string): string =>
  branch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

export const handoffPath = (branch: string): string => `${HANDOFF_DIR}/${slugifyBranch(branch)}.json`;

export const loadHandoff = (branch: string, root = process.cwd()): Handoff | null =>
  readJson<Handoff>(handoffPath(branch), root);

export const saveHandoff = (handoff: Handoff, root = process.cwd()): string => {
  const file = handoffPath(handoff.branch);
  writeJson(file, handoff, root);
  return file;
};

/** Lists every branch handoff committed in the repo. */
export function listHandoffs(root = process.cwd()): { file: string; handoff: Handoff }[] {
  const dir = path.join(root, HANDOFF_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => ({ file: `${HANDOFF_DIR}/${f}`, handoff: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Handoff }))
    .sort((a, b) => (a.handoff.updatedAt < b.handoff.updatedAt ? 1 : -1));
}

// ─── Roadmap ▸ task helpers ──────────────────────────────────────────────────

export function flattenTasks(roadmap: Roadmap): (RoadmapTask & { phase: string; phaseName: string })[] {
  return roadmap.phases.flatMap(phase =>
    phase.tasks.map(task => ({ ...task, phase: phase.id, phaseName: phase.name })),
  );
}

export function taskIndex(roadmap: Roadmap): Map<string, RoadmapTask & { phase: string; phaseName: string }> {
  return new Map(flattenTasks(roadmap).map(task => [task.id, task]));
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateRoadmap(roadmap: Roadmap): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const phase of roadmap.phases) {
    if (!phase.id || !phase.name) {
      findings.push({ level: 'error', code: 'phase-incomplete', message: `fase sem id/nome: ${JSON.stringify(phase.id)}` });
    }
    for (const task of phase.tasks) {
      if (seen.has(task.id)) {
        findings.push({ level: 'error', code: 'duplicate-task', message: `id de tarefa duplicado: ${task.id}` });
      }
      seen.add(task.id);
      if (!task.title) {
        findings.push({ level: 'error', code: 'task-title-missing', message: `tarefa ${task.id} sem título` });
      }
      if (!['todo', 'in_progress', 'blocked', 'done'].includes(task.status)) {
        findings.push({ level: 'error', code: 'task-status-invalid', message: `tarefa ${task.id} com status inválido: ${task.status}` });
      }
      if (task.status === 'done' && !task.evidence) {
        findings.push({ level: 'warn', code: 'done-without-evidence', message: `tarefa ${task.id} concluída sem 'evidence'`, hint: 'registre o artefato que comprova a entrega' });
      }
    }
  }

  for (const task of flattenTasks(roadmap)) {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) {
        findings.push({ level: 'error', code: 'self-dependency', message: `tarefa ${task.id} depende de si mesma` });
      } else if (!seen.has(dependency)) {
        findings.push({ level: 'error', code: 'unknown-dependency', message: `tarefa ${task.id} depende de ${dependency}, que não existe no roadmap` });
      }
    }
  }

  return findings;
}

/**
 * Phase discipline: a task of a later phase cannot be done / in progress while an
 * earlier phase still has open tasks (unless the task is explicitly cross-phase).
 * This is what keeps new work aligned with the project's state instead of jumping ahead.
 */
export function checkPhaseDiscipline(roadmap: Roadmap): Finding[] {
  const findings: Finding[] = [];
  const phaseOpen = (phase: RoadmapPhase) => phase.tasks.filter(t => t.status !== 'done').map(t => t.id);
  const phaseDone = (phase: RoadmapPhase) => phase.tasks.length > 0 && phase.tasks.every(t => t.status === 'done');

  roadmap.phases.forEach((phase, index) => {
    if (index === 0) return;
    const earlier = roadmap.phases.slice(0, index);
    const blocking = earlier.filter(p => !phaseDone(p));
    if (blocking.length === 0) return;

    const active = phase.tasks.filter(t => t.status === 'done' || t.status === 'in_progress');
    for (const task of active) {
      if (task.crossPhase) continue;
      findings.push({
        level: 'warn',
        code: 'phase-out-of-order',
        message: `${task.id} (${task.status}) está na fase ${phase.id} enquanto ${blocking.map(p => p.id).join(', ')} ainda tem tarefas abertas`,
        hint: `marque a tarefa com "crossPhase": true se isso for intencional, ou conclua ${blocking.flatMap(phaseOpen).join(', ')} antes`,
      });
    }
  });

  return findings;
}

export function validateHandoff(handoff: Handoff, roadmap: Roadmap, policy: Policy): Finding[] {
  const findings: Finding[] = [];
  const index = taskIndex(roadmap);

  if (!handoff.branch) findings.push({ level: 'error', code: 'handoff-branch-missing', message: 'handoff sem campo "branch"' });
  if (!['todo', 'in_progress', 'blocked', 'done'].includes(handoff.status)) {
    findings.push({ level: 'error', code: 'handoff-status-invalid', message: `status inválido no handoff: ${handoff.status}` });
  }

  const scope = handoff.scope ?? { specs: [], tasks: [], paths: [] };
  if (!scope.tasks?.length && !scope.paths?.length) {
    findings.push({
      level: 'error',
      code: 'handoff-empty-scope',
      message: 'a branch não declarou escopo (nem tarefas, nem caminhos)',
      hint: 'rode `npm run continuity:start -- --task <T-xxx>` ou edite .kiro/state/branches/<slug>.json',
    });
  }

  for (const taskId of scope.tasks ?? []) {
    if (!index.has(taskId)) {
      findings.push({ level: 'error', code: 'handoff-unknown-task', message: `handoff declara a tarefa ${taskId}, que não existe em roadmap.json` });
    }
  }
  for (const specId of scope.specs ?? []) {
    if (!(specId in policy.scopes)) {
      findings.push({ level: 'warn', code: 'handoff-unknown-spec', message: `handoff declara o spec ${specId}, que não está em policy.scopes`, hint: 'adicione o spec em policy.scopes para habilitar caminhos por spec' });
    }
  }
  if (!handoff.resumePoint?.summary?.trim()) {
    findings.push({
      level: 'error',
      code: 'handoff-no-resume-point',
      message: 'handoff sem resumePoint.summary — a próxima sessão não sabe de onde continuar',
      hint: 'preencha summary/next no handoff (npm run continuity:start também gera)',
    });
  }

  // Tasks marked done in the branch's roadmap must also be declared/kept coherent.
  for (const taskId of scope.tasks ?? []) {
    const task = index.get(taskId);
    if (!task) continue;
    if (task.status === 'done' && !task.evidence) {
      findings.push({ level: 'warn', code: 'done-without-evidence', message: `tarefa ${taskId} marcada como done no roadmap sem 'evidence'` });
    }
  }

  return findings;
}

// ─── Glob matching & scope ───────────────────────────────────────────────────

/** Minimal glob → RegExp: `**` crosses directories, `*`/`?` stay inside one segment. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // swallow a following slash so `src/**/x` also matches `src/x`
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

export function matchGlob(file: string, glob: string): boolean {
  const normalized = file.replace(/^\.\//, '');
  if (globToRegExp(glob).test(normalized)) return true;
  // `src/wasm/**` should also cover the directory entry itself
  if (glob.endsWith('/**') && normalized === glob.slice(0, -3)) return true;
  return false;
}

export function matchesAny(file: string, globs: string[] = []): boolean {
  return globs.some(glob => matchGlob(file, glob));
}

/**
 * Which changed files are covered by the branch's declared scope.
 *
 * Scope = paths declared in the handoff ∪ paths of its specs (policy.scopes)
 *         ∪ paths of its roadmap tasks (when the roadmap is provided).
 */
export function checkScope(
  changedFiles: string[],
  handoff: Handoff,
  policy: Policy,
  roadmap?: Roadmap,
): ScopeCheckResult {
  const index = roadmap ? taskIndex(roadmap) : null;
  const known = [
    ...(handoff.scope?.paths ?? []),
    ...(handoff.scope?.specs ?? []).flatMap(spec => policy.scopes[spec] ?? []),
    ...(handoff.scope?.tasks ?? []).flatMap(taskId => index?.get(taskId)?.paths ?? []),
  ];

  const result: ScopeCheckResult = { inScope: [], shared: [], state: [], outOfScope: [] };
  for (const file of changedFiles) {
    if (matchesAny(file, policy.statePaths)) result.state.push(file);
    else if (matchesAny(file, known)) result.inScope.push(file);
    else if (matchesAny(file, policy.sharedPaths)) result.shared.push(file);
    else result.outOfScope.push(file);
  }
  return result;
}

/**
 * Kernel freshness — a change to the calculation kernel must be accompanied by a
 * state update (proof that wasm/TS parity was re-checked after the change).
 *
 * The rule avoids the circularity of committing the state together with the code:
 * when the diff itself updates `project-state.json`, the sync happened in this
 * change, so the kernel is considered re-verified.
 */
export function evaluateKernelFreshness(input: {
  kernelTouched: string[];
  kernelSinceState: string[];
  stateUpdatedInDiff: boolean;
}): Finding[] {
  const { kernelTouched, kernelSinceState, stateUpdatedInDiff } = input;
  if (kernelTouched.length === 0) return [];

  if (stateUpdatedInDiff) {
    return [{
      level: 'info',
      code: 'kernel-reverified',
      message: `núcleo alterado (${kernelTouched.length} arquivo(s)) com estado sincronizado neste mesmo diff`,
    }];
  }
  if (kernelSinceState.length > 0) {
    return [{
      level: 'error',
      code: 'kernel-stale-state',
      message: `o núcleo mudou depois do último sync de estado (${kernelSinceState.slice(0, 5).join(', ')})`,
      hint: 'rode `npm run continuity:sync` e commite .kiro/state/* junto com a mudança',
    }];
  }
  return [{
    level: 'info',
    code: 'kernel-touched',
    message: `núcleo alterado (${kernelTouched.length} arquivo(s)); o CI roda wasm:verify + paridade`,
  }];
}

// ─── Progress, next tasks, state ─────────────────────────────────────────────

export function computePhaseProgress(roadmap: Roadmap): PhaseProgress[] {
  return roadmap.phases.map(phase => {
    const total = phase.tasks.length;
    const done = phase.tasks.filter(t => t.status === 'done').length;
    return {
      id: phase.id,
      name: phase.name,
      status: phase.status,
      done,
      total,
      percent: total === 0 ? 100 : Math.round((done / total) * 100),
      open: phase.tasks.filter(t => t.status !== 'done').map(t => t.id),
    };
  });
}

export function computeOverall(roadmap: Roadmap): { done: number; total: number; percent: number } {
  const tasks = flattenTasks(roadmap);
  const done = tasks.filter(t => t.status === 'done').length;
  return { done, total: tasks.length, percent: tasks.length === 0 ? 100 : Math.round((done / tasks.length) * 100) };
}

/** Open tasks whose dependencies are satisfied, in phase order. */
export function computeNextTasks(roadmap: Roadmap, limit = 5): NextTask[] {
  const index = taskIndex(roadmap);
  const next: NextTask[] = [];

  for (const task of flattenTasks(roadmap)) {
    if (task.status === 'done') continue;
    const blockedBy = (task.dependsOn ?? []).filter(dependency => {
      const dependencyTask = index.get(dependency);
      return dependencyTask ? dependencyTask.status !== 'done' : true;
    });
    next.push({
      id: task.id,
      title: task.title,
      phase: task.phase,
      phaseName: task.phaseName,
      spec: task.spec,
      verify: task.verify,
      blockedBy,
      notes: task.notes,
    });
    if (next.length >= limit) break;
  }
  return next;
}

export function currentPhase(roadmap: Roadmap): RoadmapPhase {
  return (
    roadmap.phases.find(phase => phase.tasks.some(task => task.status === 'in_progress')) ??
    roadmap.phases.find(phase => phase.tasks.some(task => task.status !== 'done')) ??
    roadmap.phases[roadmap.phases.length - 1]
  );
}

export function buildState(input: {
  roadmap: Roadmap;
  policy: Policy;
  branch: string;
  headSha: string;
  metrics?: Metrics;
  gates?: GateResult[];
  generatedAt?: string;
}): ProjectState {
  const { roadmap, policy, branch, headSha, metrics = {}, gates = [] } = input;
  const phase = currentPhase(roadmap);
  const nextTasks = computeNextTasks(roadmap, 5);
  const overall = computeOverall(roadmap);

  return {
    schema: 1,
    project: roadmap.project,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    branch,
    headSha,
    baseBranch: policy.baseBranch,
    currentPhase: phase.id,
    currentPhaseName: phase.name,
    phaseProgress: computePhaseProgress(roadmap),
    overall,
    nextTasks,
    invariants: { ...metrics, commit: headSha },
    gates,
    resume: {
      summary: `Fase ${phase.id} — ${phase.name} (${overall.percent}% do roadmap concluído)`,
      next: nextTasks.map(task => `${task.id} ${task.title}${task.blockedBy.length ? ` [bloqueado por ${task.blockedBy.join(', ')}]` : ''}`),
      commands: policy.resume?.commands ?? [],
      guardrails: policy.resume?.guardrails ?? [],
    },
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const statusIcon = (status: TaskStatus): string =>
  ({ done: '✓', in_progress: '▶', blocked: '⛔', todo: '·' } as const)[status];

export function renderStateMd(state: ProjectState): string {
  const lines: string[] = [];
  lines.push('# Estado do projeto — LLMcalc');
  lines.push('');
  lines.push(`> Gerado automaticamente por \`npm run continuity:sync\` em ${state.generatedAt} (branch \`${state.branch}\` @ \`${state.headSha.slice(0, 7)}\`).`);
  lines.push('> Não edite à mão: a fonte são `.kiro/state/roadmap.json`, `policy.json` e os handoffs em `.kiro/state/branches/`.');
  lines.push('');
  lines.push(`**Fase atual:** \`${state.currentPhase}\` — ${state.currentPhaseName} · **progresso:** ${state.overall.done}/${state.overall.total} tarefas (${state.overall.percent}%)`);
  lines.push('');
  lines.push('| fase | nome | status | tarefas | aberto |');
  lines.push('|---|---|---|---|---|');
  for (const phase of state.phaseProgress) {
    lines.push(`| ${statusIcon(phase.status)} ${phase.id} | ${phase.name} | ${phase.status} | ${phase.done}/${phase.total} (${phase.percent}%) | ${phase.open.slice(0, 6).join(', ') || '—'} |`);
  }
  lines.push('');

  lines.push('## Próximas tarefas');
  lines.push('');
  if (state.nextTasks.length === 0) {
    lines.push('Tudo concluído. 🎉');
  } else {
    lines.push('| tarefa | título | fase | bloqueio | verificação |');
    lines.push('|---|---|---|---|---|');
    for (const task of state.nextTasks) {
      lines.push(`| \`${task.id}\` | ${task.title} | ${task.phase} | ${task.blockedBy.join(', ') || '—'} | \`${task.verify ?? '—'}\` |`);
    }
  }
  lines.push('');

  lines.push('## Invariantes medidas');
  lines.push('');
  const m = state.invariants;
  lines.push('| métrica | valor |');
  lines.push('|---|---|');
  if (m.testsPassed !== undefined) lines.push(`| testes passando | ${m.testsPassed} em ${m.testFiles ?? '?'} arquivos |`);
  if (m.wasmKernelBytes !== undefined) lines.push(`| kernel wasm (browser) | ${m.wasmKernelBytes} bytes |`);
  if (m.wasiBytes !== undefined) lines.push(`| módulo WASI | ${m.wasiBytes} bytes |`);
  if (m.wasmChecks !== undefined) lines.push(`| verificações wasm | ${m.wasmChecks} |`);
  if (m.buildOk !== undefined) lines.push(`| build | ${m.buildOk ? 'ok' : 'falhou'}${m.bundleKb ? ` (chunk ${m.bundleKb} kB)` : ''} |`);
  if (m.lintErrors !== undefined) lines.push(`| lint | ${m.lintErrors} erros / ${m.lintWarnings ?? 0} avisos |`);
  if (m.dockerChecks !== undefined) lines.push(`| validações docker | ${m.dockerChecks} |`);
  if (m.stale) lines.push('| _coleta_ | parcial (`--fast`) |');
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  lines.push('| gate | resultado | detalhe |');
  lines.push('|---|---|---|');
  for (const gate of state.gates) lines.push(`| \`${gate.id}\` | ${gate.ok ? '✓' : '✗'} | ${gate.detail} |`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderResumeMd(input: {
  state: ProjectState;
  roadmap: Roadmap;
  handoff?: Handoff | null;
  recentCommits?: string[];
}): string {
  const { state, roadmap, handoff, recentCommits = [] } = input;
  const lines: string[] = [];

  lines.push('# Ponto de retomada — LLMcalc');
  lines.push('');
  lines.push(`> Briefing automático para a próxima sessão (humana ou agente). Gerado ${state.generatedAt}.`);
  lines.push('');
  lines.push('## Onde estamos');
  lines.push('');
  lines.push(`- Fase **${state.currentPhase} — ${state.currentPhaseName}**, ${state.overall.percent}% do roadmap (${state.overall.done}/${state.overall.total} tarefas).`);
  lines.push(`- Estado consolidado a partir de \`${state.branch}\` @ \`${state.headSha.slice(0, 7)}\`.`);
  if (handoff) {
    lines.push(`- Esta branch (\`${handoff.branch}\`) tem escopo declarado: tarefas ${handoff.scope.tasks.join(', ') || '—'}; specs ${handoff.scope.specs.join(', ') || '—'}.`);
    lines.push(`- Resumo do handoff: ${handoff.resumePoint.summary}`);
    if (handoff.resumePoint.next.length) {
      lines.push('- Próximos passos já registrados nesta branch:');
      for (const item of handoff.resumePoint.next) lines.push(`  - ${item}`);
    }
    if (handoff.resumePoint.blockedBy.length) {
      lines.push(`- Bloqueios: ${handoff.resumePoint.blockedBy.join('; ')}`);
    }
  } else {
    lines.push('- Sem handoff para a branch atual — rode `npm run continuity:start` para criar um.');
  }
  lines.push('');

  lines.push('## Próximas tarefas (ordem do roadmap)');
  lines.push('');
  if (state.nextTasks.length === 0) {
    lines.push('Nada pendente no roadmap.');
  } else {
    lines.push('| # | tarefa | título | fase | bloqueio | aceite |');
    lines.push('|---|---|---|---|---|---|');
    state.nextTasks.forEach((task, index) => {
      lines.push(`| ${index + 1} | \`${task.id}\` | ${task.title} | ${task.phase} | ${task.blockedBy.join(', ') || '—'} | \`${task.verify ?? '—'}\` |`);
    });
  }
  lines.push('');

  if (recentCommits.length) {
    lines.push('## Últimos commits');
    lines.push('');
    lines.push('```');
    for (const commit of recentCommits) lines.push(commit);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Guardrails (não negociáveis)');
  lines.push('');
  for (const rule of state.resume.guardrails) lines.push(`- ${rule}`);
  lines.push('');

  lines.push('## Comandos para retomar');
  lines.push('');
  lines.push('```bash');
  for (const command of state.resume.commands) lines.push(command);
  lines.push('```');
  lines.push('');

  lines.push('## Fluxo de continuidade');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run continuity:start -- --task T-xxx   # declara o escopo desta branch');
  lines.push('npm run continuity:check                   # gate local (o CI roda o mesmo)');
  lines.push('npm run continuity:sync                    # mede invariantes e atualiza o estado');
  lines.push('```');
  lines.push('');
  lines.push(`Roadmap completo: \`${ROADMAP_FILE}\` · política do gate: \`${POLICY_FILE}\` · fases abertas: ${roadmap.phases.filter(p => p.status !== 'done').map(p => p.id).join(', ') || '—'}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
