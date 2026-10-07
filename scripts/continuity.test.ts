/**
 * Unit tests for the continuity core — the gate that keeps branches aligned with
 * the project state. Spec: `.kiro/specs/17-continuity-gate.md`
 *
 * These tests are the reason the gate can be trusted: they prove the scope
 * matching, the roadmap validation and the "next task" resolution behave as
 * documented, using fixtures (never the real roadmap, which evolves).
 */
import { describe, expect, it } from 'vitest';
import {
  buildState,
  checkPhaseDiscipline,
  checkScope,
  computeNextTasks,
  computeOverall,
  computePhaseProgress,
  evaluateKernelFreshness,
  globToRegExp,
  matchGlob,
  renderResumeMd,
  renderStateMd,
  slugifyBranch,
  validateHandoff,
  validateRoadmap,
  type Handoff,
  type Policy,
  type Roadmap,
} from './lib/continuity-core.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const roadmap: Roadmap = {
  schema: 1,
  project: 'Fixture',
  version: '1.0.0',
  updatedAt: '2026-01-01',
  phases: [
    {
      id: 'P1',
      name: 'Foundation',
      goal: 'Fórmulas',
      status: 'done',
      tasks: [
        { id: 'T-1', title: 'Formulas', status: 'done', evidence: 'src/lib/formulas', paths: ['src/lib/formulas/**'] },
      ],
    },
    {
      id: 'P2',
      name: 'Wasm',
      goal: 'Kernel',
      status: 'in_progress',
      tasks: [
        { id: 'T-2', title: 'Kernel wasm', status: 'in_progress', spec: 'wasm-kernel', paths: ['wasm/**', 'src/wasm/**'], verify: 'npm run wasm:verify' },
        { id: 'T-3', title: 'Publish', status: 'todo', dependsOn: ['T-2'], paths: ['.github/workflows/deploy-pages.yml'] },
        { id: 'T-4', title: 'Experimental', status: 'in_progress', crossPhase: true, paths: ['experiments/**'] },
      ],
    },
  ],
};

const policy: Policy = {
  schema: 1,
  baseBranch: 'main',
  protectedBranches: ['main', 'dev', 'staging'],
  statePaths: ['.kiro/state/**', 'public/state.json'],
  sharedPaths: ['README.md', 'package.json', 'eslint.config.js'],
  kernelPaths: ['wasm/**', 'src/lib/formulas/**', 'src/wasm/**'],
  scopeAllowLabel: 'scope:allow',
  gateName: 'continuity-gate',
  maxStateAgeCommits: 200,
  scopes: {
    'wasm-kernel': ['wasm/kernel.ts', 'src/wasm/**', 'public/wasm/**'],
    'wasi-runtime': ['wasm/service.ts', 'scripts/wasi-*.mjs'],
  },
  resume: { commands: ['npm ci'], guardrails: ['wasm ≡ typescript'] },
};

const handoff = (overrides: Partial<Handoff> = {}): Handoff => ({
  schema: 1,
  branch: 'feat/x',
  base: 'main',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  status: 'in_progress',
  scope: { specs: ['wasm-kernel'], tasks: ['T-2'], paths: ['wasm/**'] },
  resumePoint: { summary: 'implementando o kernel', next: ['rodar wasm:verify'], blockedBy: [] },
  history: [],
  ...overrides,
});

// ─── Glob matching ───────────────────────────────────────────────────────────

describe('glob matching', () => {
  it('matches directory trees with **', () => {
    expect(matchGlob('src/wasm/kernel.ts', 'src/wasm/**')).toBe(true);
    expect(matchGlob('src/wasm/deep/nested/file.ts', 'src/wasm/**')).toBe(true);
    expect(matchGlob('src/other/file.ts', 'src/wasm/**')).toBe(false);
  });

  it('matches the directory entry itself for `dir/**`', () => {
    expect(matchGlob('wasm', 'wasm/**')).toBe(true);
  });

  it('keeps * inside a single path segment', () => {
    expect(matchGlob('scripts/wasi-run.mjs', 'scripts/wasi-*.mjs')).toBe(true);
    expect(matchGlob('scripts/wasi-nested/x.mjs', 'scripts/wasi-*.mjs')).toBe(false);
  });

  it('handles `**/` in the middle and ? wildcard', () => {
    expect(matchGlob('src/lib/formulas/vram.test.ts', 'src/**/*.test.ts')).toBe(true);
    expect(matchGlob('a/b/c.ts', 'a/?/c.ts')).toBe(true);
    expect(matchGlob('a/bb/c.ts', 'a/?/c.ts')).toBe(false);
  });

  it('escapes regex metacharacters from paths', () => {
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
    expect(globToRegExp('a+b.ts').test('aab.ts')).toBe(false);
  });
});

// ─── Scope enforcement ───────────────────────────────────────────────────────

describe('checkScope', () => {
  it('classifies in-scope, state and shared files', () => {
    const result = checkScope(
      ['wasm/kernel.ts', '.kiro/state/roadmap.json', 'README.md', 'src/pages/Home.tsx'],
      handoff(),
      policy,
      roadmap,
    );
    expect(result.inScope).toContain('wasm/kernel.ts');
    expect(result.state).toContain('.kiro/state/roadmap.json');
    expect(result.shared).toContain('README.md');
    expect(result.outOfScope).toEqual(['src/pages/Home.tsx']);
  });

  it('accepts paths contributed by the declared specs', () => {
    const loose = handoff({ scope: { specs: ['wasi-runtime'], tasks: [], paths: [] } });
    const result = checkScope(['scripts/wasi-server.mjs', 'wasm/service.ts'], loose, policy, roadmap);
    expect(result.outOfScope).toEqual([]);
    expect(result.inScope).toEqual(['scripts/wasi-server.mjs', 'wasm/service.ts']);
  });

  it('accepts paths contributed by the declared tasks of the roadmap', () => {
    // T-3 declares only .github/workflows/deploy-pages.yml
    const viaTask = handoff({ scope: { specs: [], tasks: ['T-3'], paths: [] } });
    const result = checkScope(['.github/workflows/deploy-pages.yml', 'wasm/kernel.ts'], viaTask, policy, roadmap);
    expect(result.inScope).toEqual(['.github/workflows/deploy-pages.yml']);
    expect(result.outOfScope).toEqual(['wasm/kernel.ts']);
  });
});

// ─── Roadmap validation ──────────────────────────────────────────────────────

describe('validateRoadmap', () => {
  it('accepts a coherent roadmap', () => {
    expect(validateRoadmap(roadmap).filter(f => f.level === 'error')).toEqual([]);
  });

  it('detects duplicate ids and unknown dependencies', () => {
    const broken: Roadmap = structuredClone(roadmap);
    broken.phases[1].tasks[1].id = 'T-2';
    broken.phases[1].tasks[0].dependsOn = ['T-999'];
    const codes = validateRoadmap(broken).map(f => f.code);
    expect(codes).toContain('duplicate-task');
    expect(codes).toContain('unknown-dependency');
  });

  it('requires evidence for done tasks', () => {
    const broken: Roadmap = structuredClone(roadmap);
    delete broken.phases[0].tasks[0].evidence;
    expect(validateRoadmap(broken).map(f => f.code)).toContain('done-without-evidence');
  });
});

describe('checkPhaseDiscipline', () => {
  it('does not complain about tasks inside the current phase', () => {
    expect(checkPhaseDiscipline(roadmap)).toEqual([]);
  });

  it('warns when a later phase advances while an earlier one is open', () => {
    const jumping: Roadmap = structuredClone(roadmap);
    jumping.phases.push({
      id: 'P3',
      name: 'Later',
      goal: 'g',
      status: 'in_progress',
      tasks: [{ id: 'T-9', title: 'Jumped ahead', status: 'in_progress', paths: ['x/**'] }],
    });
    const findings = checkPhaseDiscipline(jumping);
    expect(findings.map(f => f.code)).toContain('phase-out-of-order');
    expect(findings[0].message).toContain('T-9');
    expect(findings[0].hint).toContain('crossPhase');
  });

  it('respects the crossPhase escape hatch', () => {
    const jumping: Roadmap = structuredClone(roadmap);
    jumping.phases.push({
      id: 'P3',
      name: 'Later',
      goal: 'g',
      status: 'in_progress',
      tasks: [{ id: 'T-9', title: 'Declared cross-phase', status: 'in_progress', crossPhase: true, paths: ['x/**'] }],
    });
    expect(checkPhaseDiscipline(jumping)).toEqual([]);
  });
});

// ─── Handoff validation ──────────────────────────────────────────────────────

describe('validateHandoff', () => {
  it('accepts a complete handoff', () => {
    expect(validateHandoff(handoff(), roadmap, policy)).toEqual([]);
  });

  it('rejects an empty scope and a missing resume point', () => {
    const empty = handoff({ scope: { specs: [], tasks: [], paths: [] }, resumePoint: { summary: '', next: [], blockedBy: [] } });
    const codes = validateHandoff(empty, roadmap, policy).map(f => f.code);
    expect(codes).toContain('handoff-empty-scope');
    expect(codes).toContain('handoff-no-resume-point');
  });

  it('rejects tasks that do not exist in the roadmap', () => {
    const bogus = handoff({ scope: { specs: [], tasks: ['T-404'], paths: [] } });
    expect(validateHandoff(bogus, roadmap, policy).map(f => f.code)).toContain('handoff-unknown-task');
  });
});

// ─── Kernel freshness ────────────────────────────────────────────────────────

describe('evaluateKernelFreshness', () => {
  it('stays silent when the kernel was not touched', () => {
    expect(evaluateKernelFreshness({ kernelTouched: [], kernelSinceState: [], stateUpdatedInDiff: false })).toEqual([]);
  });

  it('rejects a kernel change made after the last state sync', () => {
    const findings = evaluateKernelFreshness({
      kernelTouched: ['wasm/kernel.ts'],
      kernelSinceState: ['wasm/kernel.ts', 'src/wasm/kernel.ts'],
      stateUpdatedInDiff: false,
    });
    expect(findings[0].level).toBe('error');
    expect(findings[0].code).toBe('kernel-stale-state');
    expect(findings[0].hint).toContain('continuity:sync');
  });

  it('accepts the state being updated in the same diff (no circularity)', () => {
    const findings = evaluateKernelFreshness({
      kernelTouched: ['wasm/kernel.ts'],
      kernelSinceState: ['wasm/kernel.ts'],
      stateUpdatedInDiff: true,
    });
    expect(findings[0].level).toBe('info');
    expect(findings[0].code).toBe('kernel-reverified');
  });

  it('informs when the kernel changed but nothing came after the sync', () => {
    const findings = evaluateKernelFreshness({
      kernelTouched: ['src/lib/formulas/vram.ts'],
      kernelSinceState: [],
      stateUpdatedInDiff: false,
    });
    expect(findings[0].code).toBe('kernel-touched');
  });
});

// ─── Progress & next tasks ───────────────────────────────────────────────────

describe('progress and next tasks', () => {
  it('computes per-phase and overall progress', () => {
    expect(computePhaseProgress(roadmap)[0]).toMatchObject({ id: 'P1', done: 1, total: 1, percent: 100 });
    expect(computePhaseProgress(roadmap)[1]).toMatchObject({ id: 'P2', done: 0, total: 3, percent: 0 });
    expect(computeOverall(roadmap)).toMatchObject({ done: 1, total: 4, percent: 25 });
  });

  it('reports blocked tasks with their open dependencies', () => {
    const next = computeNextTasks(roadmap, 5);
    const publish = next.find(task => task.id === 'T-3');
    expect(publish?.blockedBy).toEqual(['T-2']);
    const kernel = next.find(task => task.id === 'T-2');
    expect(kernel?.blockedBy).toEqual([]);
  });

  it('does not list a task whose dependency is done', () => {
    const finished: Roadmap = structuredClone(roadmap);
    finished.phases[1].tasks[0].status = 'done';
    const publish = computeNextTasks(finished, 5).find(task => task.id === 'T-3');
    expect(publish?.blockedBy).toEqual([]);
  });
});

// ─── State & rendering ───────────────────────────────────────────────────────

describe('buildState / rendering', () => {
  const state = buildState({
    roadmap,
    policy,
    branch: 'feat/x',
    headSha: 'abcdef1234567890',
    metrics: { testsPassed: 259, testFiles: 21, wasmKernelBytes: 2057, wasiBytes: 5728, wasmChecks: 16, buildOk: true, bundleKb: 700, lintErrors: 20, lintWarnings: 5, dockerChecks: 16 },
    gates: [{ id: 'wasm-verify', ok: true, detail: '16 verificações ok', ranAt: '2026-01-01' }],
    generatedAt: '2026-01-02T03:04:05.000Z',
  });

  it('captures phase, progress, next tasks and invariants', () => {
    expect(state.currentPhase).toBe('P2');
    expect(state.overall).toMatchObject({ done: 1, total: 4, percent: 25 });
    // roadmap order, with blockers flagged instead of hidden
    expect(state.nextTasks.map(t => t.id)).toEqual(['T-2', 'T-3', 'T-4']);
    expect(state.invariants.testsPassed).toBe(259);
    expect(state.resume.commands).toEqual(['npm ci']);
  });

  it('renders STATE.md with phases, next tasks and gates', () => {
    const md = renderStateMd(state);
    expect(md).toContain('# Estado do projeto');
    expect(md).toContain('| ✓ P1 | Foundation | done | 1/1 (100%) | — |');
    expect(md).toContain('`T-2`');
    expect(md).toContain('259 em 21 arquivos');
    expect(md).toContain('| `wasm-verify` | ✓ |');
  });

  it('renders RESUME.md with the handoff, guardrails and commands', () => {
    const md = renderResumeMd({ state, roadmap, handoff: handoff(), recentCommits: ['abc123 feat: x'] });
    expect(md).toContain('# Ponto de retomada');
    expect(md).toContain('implementando o kernel');
    expect(md).toContain('npm ci');
    expect(md).toContain('wasm ≡ typescript');
    expect(md).toContain('abc123 feat: x');
    expect(md).toContain('npm run continuity:start -- --task T-xxx');
  });

  it('renders a RESUME.md without a handoff (branch not started)', () => {
    const md = renderResumeMd({ state, roadmap, handoff: null });
    expect(md).toContain('Sem handoff para a branch atual');
  });
});

// ─── Branch slug ─────────────────────────────────────────────────────────────

describe('slugifyBranch', () => {
  it('turns branch names into file-safe slugs', () => {
    expect(slugifyBranch('arena/fe62ce6d-llm-infra-planner')).toBe('arena-fe62ce6d-llm-infra-planner');
    expect(slugifyBranch('refs/heads/feat/Wasm KernEl')).toBe('feat-wasm-kernel');
    expect(slugifyBranch('--weird--')).toBe('weird');
  });
});
