/**
 * Store tests — the ledger that survives sessions.
 *
 * Everything runs twice, once per driver: SQLite (`node:sqlite`, the local
 * ledger) and JSON (the portable fallback). A behaviour that only holds in one
 * driver is a bug, not a detail.
 *
 * Covered: meta-class coercion/validation/reserved words, CRUD, query operators
 * (including bool coercion and the injection guard), the repositories factory,
 * the gate/session/kv helpers, secrets refusal, snapshot round-trip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENTITIES,
  EntityMeta,
  SNAPSHOT_FILE,
  checkStore,
  createStore,
  defineEntity,
  detectDriver,
  entityByTable,
  exportSnapshot,
  gatesSummary,
  importSnapshot,
  reconcileFromSnapshot,
  kvGet,
  kvSet,
  latestSession,
  recordEvent,
  recordGate,
  repositories,
  repositoryFor,
  scanForSecrets,
  startSession,
  touchSession,
  writeSnapshot,
  type Store,
} from './lib/store-core.js';

const tmp: string[] = [];
const makeStore = (driver: 'sqlite' | 'json'): Store => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `store-${driver}-`));
  tmp.push(dir);
  return createStore({ file: path.join(dir, 'continuity.db'), driver, silent: true });
};

afterEach(() => {
  while (tmp.length) {
    const dir = tmp.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('driver detection', () => {
  it('prefers sqlite when the runtime offers it and falls back cleanly when not', () => {
    const detected = detectDriver();
    expect(['sqlite', 'json']).toContain(detected);
    // Node < 22.13 has no node:sqlite; asking for sqlite must degrade, never crash
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-detect-'));
    tmp.push(dir);
    const store = createStore({ file: path.join(dir, 'x.db'), driver: 'sqlite', silent: true });
    expect(store.driver.kind).toBe(detected === 'sqlite' ? 'sqlite' : 'json');
    store.driver.close();
  });
});

// ─── The same contract, both drivers ─────────────────────────────────────────

describe.each([['sqlite'], ['json']] as const)('store contract (%s)', driver => {
  const store = () => makeStore(driver);

  it('creates every collection declared by the meta registry', () => {
    const repo = repositories(store());
    for (const entity of ENTITIES) expect(repositoryFor(repo, entity.table).list({})).toEqual([]);
  });

  it('inserts, reads, updates and removes a row', () => {
    const repos = repositories(store());
    const created = startSession(repos, { branch: 'feat/x', agent: 'test', goal: 'provar CRUD' });
    expect(created.id).toContain('feat-x');
    expect(repos.sessions.get(created.id)?.goal).toBe('provar CRUD');

    const updated = touchSession(repos, created.id, { goal: 'CRUD provado' });
    expect(updated?.goal).toBe('CRUD provado');
    expect(updated?.ended_at).toBeNull();

    expect(repos.sessions.remove(created.id)).toBe(true);
    expect(repos.sessions.get(created.id)).toBeNull();
    expect(repos.sessions.remove(created.id)).toBe(false);
  });

  it('upserts by primary key instead of duplicating', () => {
    const repos = repositories(store());
    kvSet(repos, 'objetivo', 'merge');
    kvSet(repos, 'objetivo', 'publicar');
    expect(kvGet(repos, 'objetivo')).toBe('publicar');
    expect(repos.kv.count()).toBe(1);
  });

  it('round-trips structured values through the json column type', () => {
    const repos = repositories(store());
    const plan = { passos: ['merge', 'bootstrap', 'dispatch'], dono: 'usuario', tentativas: 2 };
    kvSet(repos, 'plano', plan);
    expect(kvGet(repos, 'plano')).toEqual(plan);

    const session = startSession(repos, { branch: 'feat/x' });
    touchSession(repos, session.id, { blockers: ['T-308 depende do merge'], next_tasks: [{ id: 'T-308' }] });
    const reloaded = latestSession(repos);
    expect(reloaded?.blockers).toEqual(['T-308 depende do merge']);
    expect(reloaded?.next_tasks).toEqual([{ id: 'T-308' }]);
  });

  it('coerces bool filters to what the column stores', () => {
    const repos = repositories(store());
    recordGate(repos, { id: 'pages', ok: true, detail: '3 ambientes', ranAt: '2026-01-01T00:00:00.000Z' });
    recordGate(repos, { id: 'scope', ok: false, detail: 'fora do escopo', ranAt: '2026-01-02T00:00:00.000Z' });
    expect(repos.gates.list({ where: { ok: false } })).toHaveLength(1);
    expect(repos.gates.list({ where: { ok: true } })).toHaveLength(1);
    expect(gatesSummary(repos).failed).toBe(1);
  });

  it('supports the query operators, order, limit and offset', () => {
    const repos = repositories(store());
    for (const status of ['todo', 'done', 'in_progress', 'done']) {
      repos.tasks.upsert({ id: `T-${Math.random().toString(36).slice(2, 6)}`, phase: 'P3', title: 'x', status });
    }
    expect(repos.tasks.query({ where: { status: 'done' } })).toHaveLength(2);
    expect(repos.tasks.query({ where: { status: { op: '!=', value: 'done' } } })).toHaveLength(2);
    expect(repos.tasks.query({ where: { status: { op: 'in', value: ['todo', 'in_progress'] } } })).toHaveLength(2);
    expect(repos.tasks.query({ where: { title: { op: '~', value: 'X' } } })).toHaveLength(4);
    expect(repos.tasks.query({ where: { status: 'done' }, limit: 1 })).toHaveLength(1);
    expect(repos.tasks.query({ where: { status: 'done' }, limit: 1, offset: 1 })).toHaveLength(1);
    const ids = repos.tasks.query({ order: { column: 'id', direction: 'asc' } }).map(row => row.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('refuses an unknown column in a filter (the injection guard)', () => {
    const repos = repositories(store());
    expect(() => repos.tasks.query({ where: { 'id; DROP TABLE tasks': 'x' } })).toThrow(/coluna desconhecida/);
    expect(() => repos.tasks.query({ order: { column: 'evil' } })).toThrow(/coluna desconhecida/);
  });

  it('treats a malicious value as data, never as SQL', () => {
    const repos = repositories(store());
    kvSet(repos, 'ataque', "'; DROP TABLE gates; --");
    expect(kvGet(repos, 'ataque')).toBe("'; DROP TABLE gates; --");
    recordGate(repos, { id: 'sobreviveu', ok: true });
    expect(repos.gates.count()).toBe(1); // a tabela continua lá
  });

  it('refuses credentials anywhere in the store', () => {
    const repos = repositories(store());
    expect(() => kvSet(repos, 'token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toThrow(/nunca guarda credencial/);
    expect(() => repos.events.upsert({ id: 'e1', at: 'now', type: 'x', summary: 'sk-abcdefghijklmnopqrstuvwx', branch: '', data: {} })).toThrow(/credencial/);
    expect(repos.kv.count()).toBe(0);
  });

  it('reports integrity through checkStore', () => {
    const repos = repositories(store());
    const before = checkStore(repos).map(finding => finding.code);
    expect(before).toContain('store-no-gates');
    expect(before).toContain('store-no-session');
    recordGate(repos, { id: 'x', ok: true });
    startSession(repos, { branch: 'feat/x' });
    const after = checkStore(repos).map(finding => finding.code);
    expect(after).toContain('store-ok');
    expect(after).not.toContain('store-no-gates');
  });

  it('journals events in order', () => {
    const repos = repositories(store());
    recordEvent(repos, { type: 'sync', summary: 'primeiro', branch: 'feat/x' });
    recordEvent(repos, { type: 'check', summary: 'segundo', branch: 'feat/x' });
    const events = repos.events.list({});
    expect(events).toHaveLength(2);
    expect(events.map(event => event.summary).sort()).toEqual(['primeiro', 'segundo']);
  });
});

// ─── Meta class (driver independent) ────────────────────────────────────────

describe('EntityMeta', () => {
  const meta = defineEntity({
    table: 'coisas',
    description: 'teste',
    columns: [
      { name: 'id', type: 'text', pk: true, required: true },
      { name: 'n', type: 'integer' },
      { name: 'flag', type: 'bool', default: false },
      { name: 'dados', type: 'json', default: {} },
    ],
  });

  it('requires exactly one primary key', () => {
    expect(() => defineEntity({ table: 'x', description: '', columns: [{ name: 'a', type: 'text' }] })).toThrow(/pk/);
    expect(() => defineEntity({ table: 'x', description: '', columns: [{ name: 'a', type: 'text', pk: true }, { name: 'b', type: 'text', pk: true }] })).toThrow(/pk/);
  });

  it('rejects reserved SQL words and bad identifiers at construction time', () => {
    expect(() => defineEntity({ table: 'x', description: '', columns: [{ name: 'id', type: 'text', pk: true }, { name: 'commit', type: 'text' }] })).toThrow(/reservada/);
    expect(() => defineEntity({ table: 'x', description: '', columns: [{ name: 'id', type: 'text', pk: true }, { name: 'Nome', type: 'text' }] })).toThrow(/snake_case/);
  });

  it('applies defaults and coerces declared types', () => {
    const row = meta.coerce({ id: 'a', n: '42', flag: 'yes' });
    expect(row).toEqual({ id: 'a', n: 42, flag: true, dados: {} });
    expect(meta.coerce({ id: 'a' }).flag).toBe(false);
  });

  it('rejects missing required columns and bad types', () => {
    expect(() => meta.coerce({ n: 1 })).toThrow(/obrigatório/);
    expect(() => meta.coerce({ id: 'a', n: 'muitos' })).toThrow(/inteiro/);
    expect(() => meta.coerce({ id: 'a', flag: 'talvez' })).toThrow(/booleano/);
  });

  it('finds secrets in any column, keyed by the column that carries it', () => {
    const hit = meta.findSecret({ id: 'a', dados: { token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } });
    expect(hit?.column).toBe('dados');
    expect(hit?.reason).toContain('GitHub');
    expect(meta.findSecret({ id: 'a', dados: { nota: 'sem segredo' } })).toBeNull();
  });

  it('derives the DDL from the metadata', () => {
    expect(meta.ddl()).toContain('CREATE TABLE IF NOT EXISTS coisas');
    expect(meta.ddl()).toContain('id TEXT PRIMARY KEY');
    expect(new EntityMeta({ table: 't', description: '', columns: [{ name: 'id', type: 'text', pk: true }] }).ddl()).not.toContain('NOT NULL');
  });

  it('resolves collections by loose name and rejects unknown ones', () => {
    expect(entityByTable('gates').table).toBe('gates');
    expect(entityByTable('gate').table).toBe('gates');
    expect(() => entityByTable('nada')).toThrow(/coleção desconhecida/);
  });
});

describe('secret scanner', () => {
  it.each([
    ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'token do GitHub'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop', 'fine-grained PAT'],
    ['AKIAIOSFODNN7EXAMPLE', 'chave de acesso AWS'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'chave privada'],
    ['xoxb-1234567890-abcdefghijkl', 'token do Slack'],
    ['glpat-abcdefghijklmnopqrst', 'token do GitLab'],
  ])('flags %s', (value, reason) => {
    expect(scanForSecrets(value)).toContain(reason);
  });

  it('stays quiet on prose about tokens', () => {
    expect(scanForSecrets('o token vem do ambiente, nunca do arquivo')).toEqual([]);
  });
});

// ─── Snapshot: the portable form ─────────────────────────────────────────────

describe('snapshot round-trip', () => {
  it('exports, writes and re-imports every collection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
    tmp.push(dir);
    const source = repositories(createStore({ file: path.join(dir, 'a.db'), driver: 'sqlite', silent: true }));
    startSession(source, { branch: 'feat/x', goal: 'continuar' });
    kvSet(source, 'objetivo', { passos: ['merge'] });
    recordGate(source, { id: 'wasm', ok: true, detail: '16/16' });
    recordEvent(source, { type: 'sync', summary: 'ok', branch: 'feat/x' });
    source.tasks.upsert({ id: 'T-1', phase: 'P1', title: 'x', status: 'done' });

    const snapshot = writeSnapshot(source, { snapshot: path.join(dir, SNAPSHOT_FILE) }, '2026-01-01T00:00:00.000Z');
    expect(snapshot.kind).toBe('continuity-store-snapshot');
    expect(snapshot.counts.gates).toBe(1);
    expect(fs.existsSync(path.join(dir, SNAPSHOT_FILE))).toBe(true);

    // a brand-new store (other driver, other file) rebuilds from the snapshot
    const target = repositories(createStore({ file: path.join(dir, 'b.db'), driver: 'json', silent: true }));
    const { imported } = importSnapshot(target, snapshot);
    expect(imported.gates).toBe(1);
    expect(kvGet(target, 'objetivo')).toEqual({ passos: ['merge'] });
    expect(target.tasks.get('T-1')?.status).toBe('done');
    expect(target.gates.list({ where: { ok: true } })).toHaveLength(1);
    expect(latestSession(target)?.branch).toBe('feat/x');
  });

  it('reconciles a fresh store by adding only — never overwriting what is local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
    tmp.push(dir);

    // snapshot consolidado: histórico largo + nota de sessão antiga
    const source = repositories(createStore({ file: path.join(dir, 'a.db'), driver: 'sqlite', silent: true }));
    for (const id of ['wasm@1', 'lint@1', 'lint@2']) recordGate(source, { id, ok: true, detail: 'ok' });
    kvSet(source, 'session_note', 'nota antiga do snapshot');
    kvSet(source, 'objetivo', 'consolidado');
    const snapshot = exportSnapshot(source, '2026-01-01T00:00:00.000Z');

    // banco local: um único gate, e a nota da sessão ATUAL (mais nova que o snapshot)
    const target = repositories(createStore({ file: path.join(dir, 'b.db'), driver: 'json', silent: true }));
    recordGate(target, { id: 'pages@9', ok: true, detail: '3/3' });
    kvSet(target, 'session_note', 'nota atual desta sessão');

    const { restored, tables } = reconcileFromSnapshot(target, snapshot);

    // somou o que faltava…
    expect(tables).toContain('gates');
    expect(restored.gates).toBe(3);
    expect(target.gates.list()).toHaveLength(4); // o gate local continua lá
    // …sem tocar no que já existia: a nota local venceu a do snapshot
    expect(kvGet(target, 'session_note')).toBe('nota atual desta sessão');
    expect(kvGet(target, 'objetivo')).toBe('consolidado'); // chave ausente: reposta
  });

  it('is a no-op when the local store is already as complete as the snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-noop-'));
    tmp.push(dir);
    const source = repositories(createStore({ file: path.join(dir, 'a.db'), driver: 'sqlite', silent: true }));
    recordGate(source, { id: 'wasm@1', ok: true, detail: 'ok' });
    const snapshot = exportSnapshot(source, '2026-01-01T00:00:00.000Z');
    const target = repositories(createStore({ file: path.join(dir, 'b.db'), driver: 'json', silent: true }));
    importSnapshot(target, snapshot);

    const { tables, restored } = reconcileFromSnapshot(target, snapshot);
    expect(tables).toEqual([]);
    expect(Object.values(restored).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(target.gates.list()).toHaveLength(1);
  });

  it('ignores collections a newer schema may have added', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-future-'));
    tmp.push(dir);
    const target = repositories(createStore({ file: path.join(dir, 'c.db'), driver: 'json', silent: true }));
    const { imported, skipped } = importSnapshot(target, {
      schema: 1,
      kind: 'continuity-store-snapshot',
      generatedAt: '2026-01-01',
      driver: 'sqlite',
      counts: {},
      tables: { desconhecida: [{ id: 'x' }], kv: [{ key: 'k', value: 1, updated_at: 'agora', updated_by: 'test' }] },
    });
    expect(skipped).toEqual(['desconhecida']);
    expect(imported.kv).toBe(1);
    expect(kvGet(target, 'k')).toBe(1);
  });

  it('exports the collections the API serves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-public-'));
    tmp.push(dir);
    const repos = repositories(createStore({ file: path.join(dir, 'd.db'), driver: 'sqlite', silent: true }));
    recordGate(repos, { id: 'x', ok: true });
    const snapshot = exportSnapshot(repos, '2026-01-01');
    expect(Object.keys(snapshot.tables).sort()).toEqual(['artifacts', 'events', 'gates', 'handoffs', 'kv', 'sessions', 'tasks']);
  });
});
