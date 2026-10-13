import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { attachment, emitResult, exitCodeFor, makeResult, type ActionResult } from './lib/result.js';
import {
  buildNextIssueInstruction,
  evaluateHealth,
  renderInstructionMd,
  type HealthInput,
  type PipelineTask,
} from './lib/pipeline-core.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const task = (id: string, status: string, extra: Partial<PipelineTask> = {}): PipelineTask => ({
  id,
  title: `tarefa ${id}`,
  status,
  phase: 'P4',
  phaseName: 'Qualidade contínua',
  verify: 'npm test',
  paths: ['src/**'],
  ...extra,
});

const healthInput = (overrides: Partial<HealthInput> = {}): HealthInput => ({
  branch: 'feat/x',
  headSha: 'abc1234',
  at: '2026-01-01T00:00:00.000Z',
  issues: { source: 'github', available: true, open: [] },
  ci: { available: true, failures: [], inProgress: 0, checked: 5 },
  tests: { available: true, files: 24, passed: 363, failed: 0, ok: true },
  tasks: [task('T-1', 'done'), task('T-2', 'todo')],
  ...overrides,
});

// ─── result.ts: o contrato ───────────────────────────────────────────────────

describe('result contract', () => {
  it('derives exitCode from status — never typed by hand', () => {
    expect(exitCodeFor('success')).toBe(0);
    expect(exitCodeFor('continuity')).toBe(1);
    expect(exitCodeFor('error', 1)).toBe(1); // reprovou: continua
    expect(exitCodeFor('error', 2)).toBe(2); // estrutural: para
    expect(exitCodeFor('error')).toBe(2); // padrão do erro é o tipo 2
  });

  it('builds one object with id, message, attachments, nextIssue and exitCode', () => {
    const result = makeResult({
      action: 'health',
      status: 'continuity',
      message: 'não positivo',
      at: '2026-01-01T00:00:00.000Z',
      attachments: [{ path: '.kiro/state/pipeline/health.json', filename: 'health.json', kind: 'json', bytes: 10 }],
    });
    expect(result.id).toBe('health@2026-01-01T00:00:00.000Z');
    expect(result.exitCode).toBe(1);
    expect(result.nextIssue).toBeNull();
    expect(result.errorType).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ action: 'health', status: 'continuity' });
  });

  it('marks error type only on errors, and defaults to structural (2)', () => {
    expect(makeResult({ action: 'a', status: 'error', message: 'x' }).errorType).toBe(2);
    expect(makeResult({ action: 'a', status: 'error', errorType: 1, message: 'x' }).exitCode).toBe(1);
    expect(makeResult({ action: 'a', status: 'success', message: 'x' }).errorType).toBeUndefined();
  });

  it('describes a generated attachment with its size, and never invents one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
    fs.writeFileSync(path.join(dir, 'brief.md'), 'olá');
    const described = attachment(dir, 'brief.md', 'md');
    expect(described).toMatchObject({ path: 'brief.md', filename: 'brief.md', kind: 'md', bytes: 4 });
    expect(attachment(dir, 'não-existe.pdf', 'pdf').bytes).toBeUndefined();
  });

  it('emits the JSON on stdout and returns the exit code the shell sees', () => {
    let captured = '';
    const out = { write: (chunk: string) => { captured += chunk; return true; } } as unknown as NodeJS.WriteStream;
    const result = makeResult({ action: 'complete T-9', status: 'error', errorType: 1, message: 'reprovada' });
    const code = emitResult(result, { out });
    expect(code).toBe(1);
    const parsed = JSON.parse(captured) as ActionResult;
    expect(parsed.message).toBe('reprovada');
    expect(parsed.exitCode).toBe(1);
  });
});

// ─── evaluateHealth: o gatilho ───────────────────────────────────────────────

describe('evaluateHealth', () => {
  it('is positive only with no open work, no CI error and tests passing', () => {
    const report = evaluateHealth(healthInput());
    expect(report.verdict).toBe('success');
    expect(report.exitCode).toBe(0);
    expect(report.positive).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.nextIssue).toBeNull();
  });

  it('is continuity (exit 1) while there are open items — and points at the queue head', () => {
    const report = evaluateHealth(healthInput({
      issues: { source: 'roadmap', available: true, open: [{ id: 'T-2', title: 'x' }, { id: 'T-3', title: 'y' }] },
      tasks: [task('T-1', 'done'), task('T-2', 'todo'), task('T-3', 'todo')],
    }));
    expect(report.verdict).toBe('continuity');
    expect(report.exitCode).toBe(1);
    expect(report.positive).toBe(false);
    expect(report.blockers[0]).toContain('2 item(ns) aberto(s)');
    expect(report.nextIssue?.id).toBe('T-2');
    expect(report.nextIssue?.queuePosition).toBe(1);
    expect(report.nextIssue?.queueTotal).toBe(2);
  });

  it('is continuity when CI has errors', () => {
    const report = evaluateHealth(healthInput({
      ci: { available: true, failures: [{ name: 'CI', conclusion: 'failure', url: 'https://x' }], inProgress: 1, checked: 5 },
    }));
    expect(report.exitCode).toBe(1);
    expect(report.blockers.some(b => b.includes('CI com erro'))).toBe(true);
    expect(report.checks.ciFailures).toBe(1);
  });

  it('is continuity when the test source is unavailable, empty or red', () => {
    const unavailable = evaluateHealth(healthInput({ tests: { available: false, files: 0, passed: 0, failed: 0, ok: false, reason: 'gh fora do ar' } }));
    expect(unavailable.exitCode).toBe(1);
    expect(unavailable.blockers[0]).toContain('testes: indisponível');

    const empty = evaluateHealth(healthInput({ tests: { available: true, files: 0, passed: 0, failed: 0, ok: false } }));
    expect(empty.blockers.join(' ')).toContain('nenhum arquivo de teste');

    const red = evaluateHealth(healthInput({ tests: { available: true, files: 2, passed: 3, failed: 2, ok: false } }));
    expect(red.blockers.join(' ')).toContain('2 falhando');
  });

  it('flags open tasks without a test instruction — a delivery without acceptance is not done', () => {
    const report = evaluateHealth(healthInput({
      issues: { source: 'roadmap', available: true, open: [{ id: 'T-2', title: 'x' }] },
      tasks: [task('T-1', 'done'), task('T-2', 'todo', { verify: undefined })],
    }));
    expect(report.checks.tasksWithoutTest).toEqual(['T-2']);
    expect(report.blockers.some(b => b.includes('sem instrução de teste'))).toBe(true);
    expect(report.exitCode).toBe(1);
  });

  it('fails structurally (exit 2) when there is no roadmap to walk', () => {
    const report = evaluateHealth(healthInput({ tasks: [] }));
    expect(report.verdict).toBe('error');
    expect(report.exitCode).toBe(2);
    expect(report.nextIssue).toBeNull();
  });

  it('treats in-progress CI runs as informative, not as a blocker (the gate must be able to close)', () => {
    const report = evaluateHealth(healthInput({
      ci: { available: true, failures: [], inProgress: 3, checked: 5 },
      issues: { source: 'roadmap', available: true, open: [] },
    }));
    expect(report.positive).toBe(true);
  });
});

// ─── buildNextIssueInstruction: a issue seguinte, indexada ───────────────────

describe('buildNextIssueInstruction', () => {
  const queue = [task('T-1', 'done'), task('T-2', 'todo'), task('T-3', 'todo'), task('T-4', 'done'), task('T-5', 'todo')];

  it('indexes the next open task with acceptance, scope and how to close it', () => {
    const issue = buildNextIssueInstruction(queue)!;
    expect(issue.id).toBe('T-2');
    expect(issue.index).toBe(2); // posição 1-based na sequência completa
    expect(issue.queuePosition).toBe(1);
    expect(issue.queueTotal).toBe(3);
    expect(issue.reason).toBe('next');
    expect(issue.acceptance).toBe('`npm test` retorna 0');
    expect(issue.instruction).toContain('T-2 — tarefa T-2');
    expect(issue.instruction).toContain('Teste de aceite: `npm test` retorna 0');
    expect(issue.instruction).toContain('Escopo permitido: src/**');
    expect(issue.instruction).toContain('npm run pipeline -- complete T-2 --json');
    expect(issue.actionable).toBe(true);
  });

  it('tells the truth when the task has no test: it cannot claim acceptance', () => {
    const issue = buildNextIssueInstruction([task('T-9', 'todo', { verify: undefined })])!;
    expect(issue.acceptance).toContain('sem teste definido');
    expect(issue.verify).toBeUndefined();
  });

  it('carries blockers and marks the task as not actionable', () => {
    const issue = buildNextIssueInstruction([task('T-7', 'todo', { blockedBy: ['T-308'] })])!;
    expect(issue.blockedBy).toEqual(['T-308']);
    expect(issue.actionable).toBe(false);
    expect(issue.instruction).toContain('Bloqueios: T-308');
  });

  it('switches to retry (same issue) when asked to repeat a failed verification', () => {
    const issue = buildNextIssueInstruction(queue, { retryId: 'T-3' })!;
    expect(issue.id).toBe('T-3');
    expect(issue.reason).toBe('retry');
  });

  it('finds the successor of a given task with fromId, and falls back to the head', () => {
    expect(buildNextIssueInstruction(queue, { fromId: 'T-2' })!.id).toBe('T-3');
    expect(buildNextIssueInstruction(queue, { fromId: 'T-5' })!.id).toBe('T-2'); // fim da fila: volta para a cabeça
  });

  it('returns null when the queue is empty (nothing to instruct)', () => {
    expect(buildNextIssueInstruction([task('T-1', 'done')])).toBeNull();
  });
});

describe('renderInstructionMd', () => {
  it('renders the briefing that ships with the next issue', () => {
    const issue = buildNextIssueInstruction([task('T-2', 'todo')])!;
    const md = renderInstructionMd(issue, { branch: 'feat/x', headSha: 'abc1234', at: '2026-01-01T00:00:00.000Z', verdict: 'continuity', blockers: ['2 itens abertos'] });
    expect(md).toContain('# Próxima issue — T-2');
    expect(md).toContain('veredito `continuity`');
    expect(md).toContain('npm run pipeline -- complete T-2 --json');
    expect(md).toContain('- 2 itens abertos');
    expect(md).toContain('Falha → erro tipo 1');
  });

  it('explains that the same issue returns when it is a retry', () => {
    const issue = buildNextIssueInstruction([task('T-3', 'todo')], { retryId: 'T-3' })!;
    const md = renderInstructionMd(issue, { branch: 'feat/x', headSha: 'abc1234', at: '2026-01-01T00:00:00.000Z', verdict: 'task-complete' });
    expect(md).toContain('a MESMA issue volta');
  });
});
