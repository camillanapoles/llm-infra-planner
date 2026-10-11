/**
 * Agent tests — the dispatchable GitOps actions.
 *
 * The pure half (arg parsing, audit summary, comment body) is what the workflow
 * and the CLI both rely on; the shell half is exercised by `--dry-run`, which
 * prints the exact `gh` calls without touching the API.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ACTIONS, parseAgentArgs, renderAuditMd, resumeCommentBody, summarizeAudit } from './agent.js';
import type { Snapshot } from './lib/store-core.js';

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  schema: 1,
  kind: 'continuity-store-snapshot',
  generatedAt: '2026-01-02T00:00:00.000Z',
  driver: 'sqlite',
  counts: { gates: 2, sessions: 1, events: 1, kv: 1, tasks: 5 },
  tables: {
    gates: [
      { id: 'wasm@1', ok: true, detail: '16/16', ran_at: '2026-01-02T00:00:00.000Z' },
      { id: 'lint@2', ok: false, detail: '19 erros / 5 avisos', ran_at: '2026-01-02T00:01:00.000Z' },
    ],
    sessions: [{ id: 's1', branch: 'arena/x', goal: 'publicar', resume_point: 'falta o merge', blockers: ['T-308 depende do merge'], heartbeat_at: '2026-01-02T00:02:00.000Z' }],
    events: [{ at: '2026-01-02T00:02:00.000Z', type: 'sync', summary: 'estado consolidado' }],
    kv: [{ key: 'last_sync', value: { commit: 'abc1234' }, updated_at: '2026-01-02T00:00:00.000Z', updated_by: 'cli' }],
  },
  ...overrides,
});

describe('parseAgentArgs', () => {
  it('accepts every declared action', () => {
    for (const action of AGENT_ACTIONS) {
      expect(parseAgentArgs([action]).action).toBe(action);
    }
  });

  it('rejects unknown actions with a readable list', () => {
    expect(() => parseAgentArgs(['deployar'])).toThrow(/deployar/);
    expect(() => parseAgentArgs([])).toThrow(/ação desconhecida/);
  });

  it('defaults environments to all and validates the values', () => {
    expect(parseAgentArgs(['deploy', '--ref', 'dev']).environments).toBe('all');
    expect(parseAgentArgs(['deploy', '--environments', 'dev,staging']).environments).toBe('dev,staging');
    expect(() => parseAgentArgs(['deploy', '--environments', 'prod,dev'])).toThrow(/ambiente inválido/);
  });

  it('refuses a ref that is not a normal git ref', () => {
    expect(parseAgentArgs(['deploy', '--ref', 'arena/feat-x']).ref).toBe('arena/feat-x');
    expect(() => parseAgentArgs(['deploy', '--ref', '../../etc/passwd'])).toThrow(/ref inválido/);
    expect(() => parseAgentArgs(['deploy', '--ref', 'a b'])).toThrow(/ref inválido/);
  });

  it('parses the boolean and numeric flags', () => {
    const args = parseAgentArgs(['resume', '--pr', '1', '--post', '--dry-run', '--json', '--summary', '--limit', '5']);
    expect(args).toMatchObject({ pr: 1, post: true, dryRun: true, json: true, summary: true, limit: 5 });
    expect(parseAgentArgs(['bootstrap', '--protect-main']).protectMain).toBe(true);
    expect(parseAgentArgs(['check', '--base', 'dev']).base).toBe('dev');
  });
});

describe('summarizeAudit', () => {
  it('reports failing gates, the session and staleness', () => {
    const report = summarizeAudit(snapshot(), 'fff9999');
    expect(report.gates.total).toBe(2);
    expect(report.gates.failedRuns).toBe(1);
    expect(report.gates.ok).toBe(false); // a última execução do lint falhou
    expect(report.gates.failing[0].id).toBe('lint@2');
    expect(report.lastSession?.resume_point).toBe('falta o merge');
    expect(report.lastSession?.blockers).toEqual(['T-308 depende do merge']);
    expect(report.stale).toBe(true); // abc1234 ≠ fff9999
  });

  it('judges by the latest run of each gate, not by history', () => {
    // lint falhou e depois passou: o histórico permanece, o veredito não
    const healed = snapshot({
      tables: {
        ...snapshot().tables,
        gates: [
          { id: 'lint@1', ok: false, detail: '19 erros', ran_at: '2026-01-02T00:01:00.000Z' },
          { id: 'lint@2', ok: true, detail: '0 problemas', ran_at: '2026-01-02T00:05:00.000Z' },
        ],
      },
    });
    const report = summarizeAudit(healed, 'abc1234');
    expect(report.gates.total).toBe(2);
    expect(report.gates.failedRuns).toBe(1); // o histórico continua visível
    expect(report.gates.ok).toBe(true); // a última execução passou
    expect(report.gates.failing).toEqual([]);
  });

  it('still fails when a gate id is registered only as failing', () => {
    const broken = snapshot({
      tables: { ...snapshot().tables, gates: [{ id: 'pages@1', ok: false, detail: '2/3 ambientes', ran_at: '2026-01-02T00:03:00.000Z' }] },
    });
    const report = summarizeAudit(broken, 'abc1234');
    expect(report.gates.ok).toBe(false);
    expect(report.gates.failing.map(gate => gate.id)).toEqual(['pages@1']);
  });

  it('is not stale when the snapshot commit matches HEAD', () => {
    expect(summarizeAudit(snapshot(), 'abc1234deadbeef').stale).toBe(false);
  });

  it('survives a snapshot without sessions or gates', () => {
    const report = summarizeAudit(snapshot({ tables: { kv: [], gates: [], events: [], sessions: [] }, counts: {} }), '');
    expect(report.lastSession).toBeNull();
    expect(report.gates.total).toBe(0);
    expect(report.stale).toBe(false);
  });
});

describe('renderAuditMd', () => {
  it('renders the audit as markdown for the run summary', () => {
    const md = renderAuditMd(summarizeAudit(snapshot(), 'fff9999'));
    expect(md).toContain('Auditoria do ledger');
    expect(md).toContain('gates registrados: **2**');
    expect(md).toContain('veredito pela última execução de cada gate: **há gate vermelho**');
    expect(md).toContain('lint@2');
    expect(md).toContain('atrás do HEAD');
    expect(md).toContain('bloqueios: T-308 depende do merge');
  });
});

describe('resumeCommentBody', () => {
  it('carries the marker, the actor and the briefing', () => {
    const body = resumeCommentBody('# Ponto de retomada\n\n- fase P3', 'user', 'https://example.com/run/1');
    expect(body.startsWith('<!-- agent-resume -->')).toBe(true);
    expect(body).toContain('pedido por `user`');
    expect(body).toContain('[run](https://example.com/run/1)');
    expect(body).toContain('fase P3');
  });

  it('works without a run url', () => {
    const body = resumeCommentBody('briefing', 'agent');
    expect(body).toContain('pedido por `agent`');
    expect(body).not.toContain('[run]');
  });
});
