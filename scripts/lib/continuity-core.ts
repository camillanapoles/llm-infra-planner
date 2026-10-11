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
export const ACCESS_FILE = `${STATE_DIR}/access.json`;
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

// ─── Scope inference for new branches ────────────────────────────────────────

/** Accent-insensitive lowercase, so `Suíte` in a title matches `suite` in a branch. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export type ScopeInferenceKind = 'explicit' | 'resume-point' | 'promotion' | 'none';

export interface InferredScope {
  kind: ScopeInferenceKind;
  tasks: string[];
  specs: string[];
  paths: string[];
  /** Human-readable explanation — recorded in the handoff and printed by the CLI. */
  reason: string;
}

/**
 * Infers the scope of a branch from the roadmap alone.
 *
 * This is what makes continuity automatic: a branch created after a merge does
 * not need anyone to narrate what it is for — the roadmap says where the project
 * stopped, and the handoff is derived from it.
 *
 * Tiers, in order of precision:
 *   1. `explicit`     — the branch name names a task (`t-401`/`t401`/`401`) or a
 *                       word of its title, or a spec (`13-deploy-github-pages`
 *                       or a distinctive word of it);
 *   2. `resume-point` — nothing matched, so the branch inherits the next
 *                       unblocked task: it continues exactly where the project
 *                       stopped, instead of failing as "empty scope";
 *   3. `promotion`    — `dev`/`staging`/`main` carry whole-tree merges, so file
 *                       scope does not apply to them;
 *   4. `none`         — nothing matched and the roadmap has no open task left.
 */
export function inferScope(branch: string, roadmap: Roadmap, policy: Policy): InferredScope {
  const haystack = normalize(branch);
  const tasks = flattenTasks(roadmap);
  const index = taskIndex(roadmap);

  if (policy.protectedBranches.includes(branch)) {
    return {
      kind: 'promotion',
      tasks: [],
      specs: [],
      paths: [],
      reason: `"${branch}" é branch de ambiente (${policy.protectedBranches.join('/')}): promoção carrega um merge de árvore inteira, então escopo de arquivos não se aplica`,
    };
  }

  const taskIds = new Set<string>();
  const specs = new Set<string>();

  // tier 1a — task id in any spelling: t-401, t401, 401
  const idTokens = new Set<string>();
  for (const match of haystack.matchAll(/(?:^|[^0-9a-z])(?:t-?)?(\d{1,4})(?![0-9a-z])/g)) idTokens.add(match[1]);
  if (idTokens.size) {
    for (const task of tasks) {
      const digits = task.id.replace(/\D/g, '');
      if (digits && idTokens.has(digits)) taskIds.add(task.id);
    }
  }

  // tier 1b — a word of the task title (>= 4 chars) appears in the branch name
  if (taskIds.size === 0) {
    for (const task of tasks) {
      const words = normalize(`${task.title} ${task.spec ?? ''}`)
        .split(/[^a-z0-9]+/)
        .filter(word => word.length >= 4);
      if (words.some(word => haystack.includes(word))) taskIds.add(task.id);
    }
  }

  // tier 1c — a spec slug (`13-deploy-github-pages`) or a distinctive word of it
  if (taskIds.size === 0) {
    for (const spec of Object.keys(policy.scopes)) {
      const slug = normalize(spec);
      const words = slug.split(/[^a-z0-9]+/).filter(word => word.length >= 5);
      if (haystack.includes(slug) || words.some(word => haystack.includes(word))) specs.add(spec);
    }
    // declaring the spec also declares the tasks it still owes the roadmap
    for (const task of tasks) {
      if (task.spec && specs.has(task.spec) && task.status !== 'done') taskIds.add(task.id);
    }
  }

  if (taskIds.size || specs.size) {
    const paths = [
      ...new Set([
        ...[...taskIds].flatMap(id => index.get(id)?.paths ?? []),
        ...[...specs].flatMap(spec => policy.scopes[spec] ?? []),
      ]),
    ];
    return {
      kind: 'explicit',
      tasks: [...taskIds],
      specs: [...specs],
      paths,
      reason: `escopo reconhecido no nome da branch: ${[...taskIds, ...specs].join(', ')}`,
    };
  }

  // tier 2 — resume point: continue exactly where the project stopped.
  // The first open task whose dependencies are satisfied is the honest answer;
  // if every open task is blocked, the first one is still where the project is.
  const open = computeNextTasks(roadmap, flattenTasks(roadmap).length || 1);
  const next = open.find(task => task.blockedBy.length === 0) ?? open[0];
  const nextTask = next ? index.get(next.id) : undefined;
  if (next && nextTask) {
    const paths = [
      ...new Set([...(nextTask.paths ?? []), ...(nextTask.spec ? policy.scopes[nextTask.spec] ?? [] : [])]),
    ];
    return {
      kind: 'resume-point',
      tasks: [nextTask.id],
      specs: nextTask.spec ? [nextTask.spec] : [],
      paths,
      reason: `nada no nome da branch; escopo herdado do ponto de retomada: ${nextTask.id} — ${nextTask.title}`,
    };
  }

  return {
    kind: 'none',
    tasks: [],
    specs: [],
    paths: [],
    reason: 'nenhum escopo reconhecido no nome da branch e o roadmap não tem tarefa aberta',
  };
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

// ─── Access descriptor (the JSON a new session reads first) ──────────────────
//
// One machine-readable object per project: where the repo lives, which branch is
// the working one, how to reach the runtime, what is deployed where, which
// commands resume the work and what still blocks it.
//
// It carries **no credentials**. Access here means coordinates + commands; the
// authentication comes from the environment (`gh auth`), never from a file that
// is committed next to the code (policy guardrail: "sem segredos versionados").

export interface AccessDescriptor {
  schema: 1;
  kind: 'project-access-descriptor';
  project: string;
  generatedAt: string;
  provenance: { headSha: string; branch: string; baseBranch: string; generatedBy: string; sources: string[] };
  credentials: { policy: string; auth: string; check: string; never: string[] };
  coordinates: {
    repo: string;
    remote: string;
    siteOrigin: string;
    branches: { working: string; default: string; environments: string[] };
    pullRequest: { number: number; url: string } | null;
  };
  runtime: {
    local: { page: string; wasi: string; commands: string[]; endpoints: string[] };
    artifact: { build: string; verify: string; serve: string };
  };
  deploy: {
    provider: string;
    environments: Record<string, { url: string; base: string; source: string }>;
    dispatch: { requires: string; commands: string[] };
    automatic: { trigger: string; workflow: string };
  };
  continuity: {
    gate: string;
    sync: string;
    resume: string;
    handoff: string;
    readOrder: string[];
    resumeCommands: string[];
    nextTasks: { id: string; title: string; blockedBy: string[] }[];
    blockers: string[];
  };
  validation: { command: string; checks: string[] };
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
];
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|credential|bearer/i;

/** Every string in the object, with the path that leads to it (for honest messages). */
function walkStrings(value: unknown, prefix = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path: prefix || '(root)', value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => walkStrings(item, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => walkStrings(item, prefix ? `${prefix}.${key}` : key));
  }
  return [];
}

export function buildAccessDescriptor(input: {
  roadmap: Roadmap;
  policy: Policy;
  state: ProjectState;
  handoff: Handoff | null;
  coordinates: AccessDescriptor['coordinates'];
  generatedAt?: string;
  generatedBy?: string;
  localPorts?: { page: number; wasi: number };
}): AccessDescriptor {
  const { roadmap, policy, state, handoff, coordinates } = input;
  const page = input.localPorts?.page ?? 5173;
  const wasi = input.localPorts?.wasi ?? 8787;
  const [owner] = coordinates.repo.split('/');
  const environments = policy.protectedBranches.filter(branch => branch !== policy.baseBranch);

  return {
    schema: 1,
    kind: 'project-access-descriptor',
    project: roadmap.project,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    provenance: {
      headSha: state.invariants.commit ?? state.headSha,
      branch: state.branch,
      baseBranch: policy.baseBranch,
      generatedBy: input.generatedBy ?? 'npm run continuity:sync',
      sources: [ROADMAP_FILE, POLICY_FILE, STATE_FILE, handoffPath(state.branch)],
    },
    credentials: {
      policy: 'este arquivo é versionado e público — nenhum segredo mora aqui',
      auth: 'a autenticação vem do ambiente (gh CLI já autenticado); o arquivo só descreve coordenadas e comandos',
      check: 'gh auth status',
      never: ['tokens', 'chaves privadas', 'senhas', 'cookies de sessão'],
    },
    coordinates: { ...coordinates, siteOrigin: `https://${owner}.github.io` },
    runtime: {
      local: {
        page: `http://localhost:${page}`,
        wasi: `http://localhost:${wasi}`,
        commands: ['npm run stack'],
        endpoints: ['/api/access', '/api/health', '/api/selftest', '/api/plan?...', '/api/kv?...', '/api/roofline?...', '/api/gpus?...', '/api/latency?...', 'POST /api/compute'],
      },
      artifact: {
        build: 'node scripts/build-pages-artifact.mjs --env all --out _site',
        verify: 'bash scripts/verify-pages-artifact.sh _site',
        serve: `node scripts/serve-static.mjs _site --base /${coordinates.repo.split('/')[1]}/`,
      },
    },
    deploy: {
      provider: 'github-pages',
      environments: Object.fromEntries([
        [policy.baseBranch, { url: `${`https://${owner}.github.io`}/${coordinates.repo.split('/')[1]}/`, base: `/${coordinates.repo.split('/')[1]}/`, source: policy.baseBranch }],
        ...environments.map(env => [
          env,
          { url: `${`https://${owner}.github.io`}/${coordinates.repo.split('/')[1]}/${env}/`, base: `/${coordinates.repo.split('/')[1]}/${env}/`, source: env },
        ]),
      ]),
      dispatch: {
        requires: 'workflow_dispatch só existe na branch default — o workflow precisa estar na main',
        commands: [
          'gh workflow run bootstrap-repo.yml -f protect_main=true',
          `gh workflow run deploy-pages.yml -f ref=${state.branch} -f environments=${environments.join(',') || 'dev'}`,
        ],
      },
      automatic: {
        trigger: `push em ${[policy.baseBranch, ...environments].join('/')}`,
        workflow: '.github/workflows/deploy-pages.yml',
      },
    },
    continuity: {
      gate: 'npm run continuity:check',
      sync: 'npm run continuity:sync',
      resume: 'npm run continuity:resume',
      handoff: handoffPath(state.branch),
      readOrder: ['.kiro/state/access.json', RESUME_FILE, STATE_MD_FILE, 'CONTINUITY.md'],
      resumeCommands: [
        `git fetch origin && git reset --hard origin/${state.branch}`,
        'npm ci',
        'npm run build:wasm',
        'npm run continuity:status',
        'npm run stack',
      ],
      nextTasks: state.nextTasks.map(task => ({ id: task.id, title: task.title, blockedBy: task.blockedBy })),
      blockers: handoff?.resumePoint.blockedBy ?? [],
    },
    validation: {
      command: 'npm run validate:access',
      checks: ['sem segredos', 'comandos existem no repo', 'tarefas batem com o roadmap', 'sha/branch batem com o HEAD'],
    },
  };
}

export function validateAccessDescriptor(
  descriptor: unknown,
  ctx: { scripts: string[]; exists: (relativePath: string) => boolean; headSha: string; branch: string; roadmap: Roadmap },
): Finding[] {
  const findings: Finding[] = [];
  const requiredTop = ['schema', 'kind', 'project', 'generatedAt', 'provenance', 'credentials', 'coordinates', 'runtime', 'deploy', 'continuity', 'validation'];
  if (!descriptor || typeof descriptor !== 'object') {
    return [{ level: 'error', code: 'access-shape', message: 'descriptor de acesso não é um objeto JSON' }];
  }
  const access = descriptor as AccessDescriptor;
  for (const key of requiredTop) {
    if (!(key in (access as unknown as Record<string, unknown>))) {
      findings.push({ level: 'error', code: 'access-shape', message: `descriptor de acesso sem o campo obrigatório "${key}"` });
    }
  }
  if (access.schema !== 1) findings.push({ level: 'error', code: 'access-schema', message: `schema inesperado: ${String(access.schema)} (esperado 1)` });
  if (access.kind !== 'project-access-descriptor') findings.push({ level: 'error', code: 'access-kind', message: `kind inesperado: ${String(access.kind)}` });

  // 1. no secrets — the descriptor is committed and public
  for (const { path: at, value } of walkStrings(descriptor)) {
    if (SECRET_PATTERNS.some(pattern => pattern.test(value))) {
      findings.push({ level: 'error', code: 'access-secret', message: `valor com cara de segredo em ${at}`, hint: 'descreva o acesso por comando/coordenada; credencial vem do ambiente' });
    }
    if (SECRET_KEY.test(at.split('.').pop() ?? '') && value.trim() && !at.startsWith('credentials.never')) {
      findings.push({ level: 'error', code: 'access-secret-key', message: `campo "${at}" parece guardar credencial`, hint: 'remova o campo — o JSON nunca carrega segredo' });
    }
  }

  // 2. every command must exist in the repository
  const commands = [
    ...(access.continuity?.resumeCommands ?? []),
    ...(access.runtime?.local?.commands ?? []),
    ...(access.runtime?.artifact ? Object.values(access.runtime.artifact) : []),
    ...(access.deploy?.dispatch?.commands ?? []),
    ...(access.continuity ? [access.continuity.gate, access.continuity.sync, access.continuity.resume] : []),
    ...(access.validation?.command ? [access.validation.command] : []),
  ].filter((command): command is string => typeof command === 'string' && command.length > 0);

  for (const command of commands) {
    for (const [, script] of command.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
      if (!ctx.scripts.includes(script)) {
        findings.push({ level: 'error', code: 'access-script-missing', message: `comando cita "npm run ${script}", que não existe em package.json` });
      }
    }
    for (const [, file] of command.matchAll(/(?:node|npx tsx|bash) (scripts\/[A-Za-z0-9._/-]+)/g)) {
      if (!ctx.exists(file)) {
        findings.push({ level: 'error', code: 'access-file-missing', message: `comando cita ${file}, que não existe no repositório` });
      }
    }
    for (const [, workflow] of command.matchAll(/gh workflow run ([A-Za-z0-9._-]+\.ya?ml)/g)) {
      if (!ctx.exists(`.github/workflows/${workflow}`)) {
        findings.push({ level: 'error', code: 'access-workflow-missing', message: `comando cita o workflow ${workflow}, que não existe em .github/workflows/` });
      }
    }
  }

  // 3. consistency with the repository it describes
  const index = taskIndex(ctx.roadmap);
  const detached = !ctx.branch || ctx.branch === 'HEAD';
  if (access.provenance && !detached && access.provenance.branch !== ctx.branch) {
    findings.push({ level: 'warn', code: 'access-branch-stale', message: `descriptor gerado na branch "${access.provenance.branch}", HEAD atual em "${ctx.branch}"`, hint: 'rode `npm run continuity:sync`' });
  }
  if (access.provenance && access.provenance.headSha !== ctx.headSha) {
    findings.push({ level: 'warn', code: 'access-sha-stale', message: `descriptor aponta para ${String(access.provenance.headSha).slice(0, 7)}, HEAD em ${ctx.headSha.slice(0, 7)}`, hint: 'rode `npm run continuity:sync`' });
  }
  for (const task of access.continuity?.nextTasks ?? []) {
    const known = index.get(task.id);
    if (!known) findings.push({ level: 'error', code: 'access-unknown-task', message: `descriptor lista a tarefa ${task.id}, que não existe no roadmap` });
    else if (known.status === 'done') findings.push({ level: 'warn', code: 'access-stale-next', message: `${task.id} já está done mas continua listada como próxima`, hint: 'rode `npm run continuity:sync`' });
  }
  for (const handle of Object.values(access.deploy?.environments ?? {})) {
    if (typeof handle?.url === 'string' && !handle.url.startsWith(`${access.coordinates?.siteOrigin ?? ''}/${access.coordinates?.repo?.split('/')[1] ?? ''}`)) {
      findings.push({ level: 'error', code: 'access-url-mismatch', message: `URL de ambiente fora do site do projeto: ${handle.url}` });
    }
    if (typeof handle?.base === 'string' && !handle.base.startsWith(`/${access.coordinates?.repo?.split('/')[1] ?? ''}/`)) {
      findings.push({ level: 'error', code: 'access-base-mismatch', message: `base path fora do projeto: ${handle.base}` });
    }
  }

  if (!findings.some(finding => finding.level === 'error')) {
    findings.push({ level: 'info', code: 'access-ok', message: `descriptor de acesso válido (${commands.length} comandos conferidos, ${(access.continuity?.nextTasks ?? []).length} próximas tarefas)` });
  }
  return findings;
}
