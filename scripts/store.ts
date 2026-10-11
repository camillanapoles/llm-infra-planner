#!/usr/bin/env -S npx tsx
/**
 * Continuity store CLI — CRUD, query and the gate ledger.
 *
 *   npm run store -- init                          cria/valida o schema
 *   npm run store -- check                         integridade + varredura de segredos
 *   npm run store -- set <chave> <valor…>          objeto que a sessão seta…
 *   npm run store -- get <chave>                   …e recupera
 *   npm run store -- del <chave>
 *   npm run store -- ls <coleção> [--limit N]
 *   npm run store -- show <coleção> <id>
 *   npm run store -- query <coleção> --where 'status=done,phase=P3' --order id:desc --limit 5
 *   npm run store -- event <tipo> <resumo…>
 *   npm run store -- gate <id> --ok false --detail "…"
 *   npm run store -- session start|note|end [--goal …] [--resume …]
 *   npm run store -- export                        snapshot versionável (git + /api/store)
 *   npm run store -- import                        reconstrói o banco a partir do snapshot
 *   npm run store -- sessions|events|gates         atalhos de leitura
 *
 * Flags comuns: --json (saída de máquina) · --driver sqlite|json · --db <caminho>
 *
 * O store NUNCA guarda credencial (ver `scanForSecrets`): token vazado em
 * qualquer coluna é erro, não aviso.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTITIES,
  PUBLIC_SNAPSHOT_FILE,
  SNAPSHOT_FILE,
  STORE_FILE,
  checkStore,
  createStore,
  entityByTable,
  gatesSummary,
  importSnapshot,
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
  type Operator,
  type QuerySpec,
  type Row,
  type Snapshot,
} from './lib/store-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const rest = argv.slice(1);

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', reset: '\x1b[0m' };
const has = (...flags: string[]): boolean => flags.some(flag => argv.includes(flag));
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const positional = (): string[] => {
  const out: string[] = [];
  const takesValue = new Set(['--where', '--order', '--limit', '--offset', '--driver', '--db', '--detail', '--goal', '--resume', '--agent', '--commit', '--branch', '--at']);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('--')) continue;
    out.push(token);
  }
  return out;
};

const dbFile = flag('--db') ? path.resolve(root, flag('--db') as string) : path.join(root, STORE_FILE);
const driver = (flag('--driver') as 'sqlite' | 'json' | undefined) ?? 'auto';

function open() {
  const store = createStore({ file: dbFile, driver, silent: true });
  return { store, repos: repositories(store) };
}

const out = (value: unknown, human: string): void => {
  if (has('--json')) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(human.endsWith('\n') ? human : `${human}\n`);
};
const fail = (message: string): number => {
  process.stderr.write(`${C.red}✗${C.reset} ${message}\n`);
  return 1;
};

/** `--where 'status=done,phase=P3,title~kernel,id in T-1|T-2'` → QuerySpec */
export function parseWhere(raw: string | undefined): QuerySpec['where'] {
  if (!raw) return undefined;
  const where: NonNullable<QuerySpec['where']> = {};
  for (const clause of raw.split(',')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(!=|>=|<=|=|>|<|~|\bin\b)\s*(.+?)\s*$/i.exec(clause);
    if (!match) throw new Error(`cláusula inválida: "${clause}" (use coluna=valor, coluna~texto, coluna>=2, coluna in a|b)`);
    const [, column, rawOp, value] = match;
    const op = rawOp.toLowerCase() as Operator;
    where[column] = { op, value: op === 'in' ? value.split('|') : value };
  }
  return where;
}
function parseOrder(raw: string | undefined): QuerySpec['order'] {
  if (!raw) return undefined;
  const [column, direction = 'asc'] = raw.split(':');
  return { column, direction: direction.toLowerCase() === 'desc' ? 'desc' : 'asc' };
}

function renderRows(rows: Row[]): string {
  if (!rows.length) return `${C.dim}(vazio)${C.reset}`;
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const width = (column: string): number => Math.max(column.length, ...rows.map(row => String(formatCell(row[column])).length));
  const line = (cells: string[]): string => cells.map((cell, index) => cell.padEnd(width(columns[index]))).join('  ');
  const header = line(columns).trimEnd();
  const body = rows.map(row => line(columns.map(column => formatCell(row[column]))).trimEnd());
  return `${C.bold}${header}${C.reset}\n${body.join('\n')}`;
}
const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return '·';
  if (typeof value === 'object') return Array.isArray(value) ? (value.length ? value.join('|') : '[]') : JSON.stringify(value);
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
};

function main(): number {
  const args = positional();
  const { store, repos } = open();

  try {
    switch (command) {
      case 'init': {
        out({ driver: store.driver.kind, file: path.relative(root, store.file), collections: ENTITIES.map(entity => entity.table) },
          `${C.green}✓${C.reset} store ${store.driver.kind} pronto em ${C.bold}${path.relative(root, store.file)}${C.reset}\n  coleções: ${ENTITIES.map(entity => entity.table).join(', ')}`);
        return 0;
      }

      case 'check': {
        const findings = checkStore(repos);
        const errors = findings.filter(finding => finding.level === 'error');
        if (has('--json')) process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, findings }, null, 2)}\n`);
        else {
          process.stdout.write(`\n${C.bold}Store${C.reset} ${C.dim}${path.relative(root, store.file)} · driver ${store.driver.kind}${C.reset}\n\n`);
          for (const finding of findings) {
            const icon = finding.level === 'error' ? `${C.red}✗${C.reset}` : finding.level === 'warn' ? `${C.yellow}!${C.reset}` : `${C.blue}i${C.reset}`;
            process.stdout.write(`  ${icon} ${finding.code}: ${finding.message}\n`);
          }
          process.stdout.write(errors.length === 0 ? `\n${C.green}✓ store ok${C.reset}\n\n` : `\n${C.red}✗ ${errors.length} problema(s)${C.reset}\n\n`);
        }
        return errors.length === 0 ? 0 : 1;
      }

      case 'set': {
        const [key, ...valueParts] = args;
        if (!key || !valueParts.length) return fail('uso: store set <chave> <valor…> (valor JSON é aceito: store set x \'{"a":1}\')');
        const raw = valueParts.join(' ');
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          /* texto simples */
        }
        const row = kvSet(repos, key, value, flag('--agent') ?? 'cli');
        out(row, `${C.green}✓${C.reset} ${C.bold}${key}${C.reset} = ${formatCell(row.value)} ${C.dim}(${row.updated_at})${C.reset}`);
        return 0;
      }

      case 'get': {
        const [key] = args;
        if (!key) return fail('uso: store get <chave>');
        const value = kvGet(repos, key);
        if (value === null) return fail(`chave "${key}" não existe no store`);
        out({ key, value }, typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
        return 0;
      }

      case 'del': {
        const [key] = args;
        if (!key) return fail('uso: store del <chave>');
        const removed = repos.kv.remove(key);
        out({ key, removed }, removed ? `${C.green}✓${C.reset} ${key} removido` : `${C.yellow}!${C.reset} ${key} não existia`);
        return removed ? 0 : 1;
      }

      case 'ls': {
        const [collection] = args;
        if (!collection) return fail(`uso: store ls <coleção> (${ENTITIES.map(entity => entity.table).join(', ')})`);
        const rows = repositoryFor(repos, collection).list({ order: parseOrder(flag('--order')), limit: flag('--limit') ? Number(flag('--limit')) : undefined });
        out(rows, renderRows(rows));
        return 0;
      }

      case 'show': {
        const [collection, id] = args;
        if (!collection || !id) return fail('uso: store show <coleção> <id>');
        const row = repositoryFor(repos, collection).get(id);
        if (!row) return fail(`${entityByTable(collection).table} não tem "${id}"`);
        out(row, JSON.stringify(row, null, 2));
        return 0;
      }

      case 'query': {
        const [collection] = args;
        if (!collection) return fail('uso: store query <coleção> [--where …] [--order col:desc] [--limit N] [--json]');
        let spec: QuerySpec;
        try {
          spec = { where: parseWhere(flag('--where')), order: parseOrder(flag('--order')), limit: flag('--limit') ? Number(flag('--limit')) : undefined, offset: flag('--offset') ? Number(flag('--offset')) : undefined };
        } catch (error) {
          return fail((error as Error).message);
        }
        const rows = repositoryFor(repos, collection).query(spec);
        out({ collection: entityByTable(collection).table, count: rows.length, rows }, `${C.bold}${rows.length}${C.reset} linha(s) em ${entityByTable(collection).table}\n${renderRows(rows)}`);
        return 0;
      }

      case 'event': {
        const [type, ...summaryParts] = args;
        if (!type || !summaryParts.length) return fail('uso: store event <tipo> <resumo…>');
        const row = recordEvent(repos, { type, summary: summaryParts.join(' '), branch: flag('--branch') ?? '' });
        out(row, `${C.green}✓${C.reset} evento ${C.bold}${type}${C.reset} registrado ${C.dim}(${row.id})${C.reset}`);
        return 0;
      }

      case 'gate': {
        const [id] = args;
        if (!id) return fail('uso: store gate <id> --ok true|false [--detail "…"]');
        const okRaw = (flag('--ok') ?? 'true').toLowerCase();
        const row = recordGate(repos, { id, ok: /^(true|1|yes|ok)$/.test(okRaw), detail: flag('--detail') ?? '', commit: flag('--commit') ?? '', branch: flag('--branch') ?? '', ranAt: flag('--at') });
        out(row, `${row.ok ? C.green + '✓' : C.red + '✗'}${C.reset} gate ${C.bold}${id}${C.reset} ${row.detail} ${C.dim}(${row.ran_at})${C.reset}`);
        return row.ok ? 0 : 1;
      }

      case 'session': {
        const [action = 'start'] = args;
        if (action === 'start') {
          const row = startSession(repos, { branch: flag('--branch') ?? '', agent: flag('--agent') ?? 'cli', goal: flag('--goal') ?? '' });
          out(row, `${C.green}✓${C.reset} sessão ${C.bold}${row.id}${C.reset} iniciada ${C.dim}(${row.branch})${C.reset}`);
          return 0;
        }
        const latest = latestSession(repos);
        if (!latest) return fail('nenhuma sessão registrada — rode `store session start`');
        if (action === 'note' || action === 'end') {
          const summary = rest.filter(token => !token.startsWith('--') && token !== action).join(' ');
          const patch: Row = { resume_point: flag('--resume') ?? summary ?? '' };
          if (action === 'end') patch.ended_at = new Date().toISOString();
          const row = touchSession(repos, String(latest.id), patch);
          out(row, `${C.green}✓${C.reset} sessão ${C.bold}${String(latest.id)}${C.reset} ${action === 'end' ? 'encerrada' : 'anotada'}`);
          return 0;
        }
        return fail(`ação desconhecida: ${action} (start|note|end)`);
      }

      case 'sessions':
      case 'events':
      case 'gates': {
        if (command === 'gates' && has('--summary')) {
          const summary = gatesSummary(repos, Number(flag('--limit') ?? 10));
          out(summary, `${summary.total} execuções · ${summary.failed} falha(s)\n${renderRows(summary.recent)}`);
          return 0;
        }
        const defaultOrder = command === 'sessions' ? 'started_at:desc' : command === 'events' ? 'at:desc' : 'ran_at:desc';
        const rows = repositoryFor(repos, command).list({ limit: flag('--limit') ? Number(flag('--limit')) : 10, order: parseOrder(flag('--order') ?? defaultOrder) });
        out(rows, renderRows(rows));
        return 0;
      }

      case 'export': {
        const snapshot = writeSnapshot(repos, { snapshot: path.join(root, SNAPSHOT_FILE), publicSnapshot: path.join(root, PUBLIC_SNAPSHOT_FILE) });
        out({ file: SNAPSHOT_FILE, counts: snapshot.counts }, `${C.green}✓${C.reset} snapshot → ${C.bold}${SNAPSHOT_FILE}${C.reset} + ${PUBLIC_SNAPSHOT_FILE}\n  ${Object.entries(snapshot.counts).map(([table, count]) => `${table}=${count}`).join(' · ')}`);
        return 0;
      }

      case 'import': {
        if (!fs.existsSync(path.join(root, SNAPSHOT_FILE))) return fail(`${SNAPSHOT_FILE} não existe — nada para importar`);
        const snapshot = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf8')) as Snapshot;
        const { imported, skipped } = importSnapshot(repos, snapshot);
        out({ imported, skipped }, `${C.green}✓${C.reset} importado: ${Object.entries(imported).map(([table, count]) => `${table}=${count}`).join(' · ')}${skipped.length ? `\n  ${C.yellow}!${C.reset} ignorado (schema mais novo): ${skipped.join(', ')}` : ''}`);
        return 0;
      }

      case 'scan': {
        const [text] = args;
        const hits = scanForSecrets(text ?? '');
        out({ text, hits }, hits.length ? `${C.red}✗${C.reset} parece credencial: ${hits.join(', ')}` : `${C.green}✓${C.reset} nenhum padrão de segredo`);
        return hits.length ? 1 : 0;
      }

      default:
        process.stdout.write(`
${C.bold}store${C.reset} — ledger de continuidade do projeto (SQLite + snapshot versionável)

  init                                  cria/valida o schema
  check                                 integridade + varredura de segredos
  set <chave> <valor…> | get <chave> | del <chave>
  ls <coleção> | show <coleção> <id> | query <coleção> --where … --order … --limit N
  event <tipo> <resumo…> | gate <id> --ok false --detail "…"
  session start|note|end [--goal …] [--resume …]
  export | import
  sessions | events | gates [--summary]

Coleções: ${ENTITIES.map(entity => entity.table).join(', ')}
Flags: --json · --driver sqlite|json · --db <caminho> · --agent <nome>
`);
        return command === 'help' || has('--help', '-h') ? 0 : 1;
    }
  } catch (error) {
    // Guardas do meta-layer (coluna desconhecida, segredo recusado, tipo errado)
    // falam com quem usou o CLI — stack trace não é resposta.
    return fail((error as Error).message);
  } finally {
    store.driver.close();
  }
}

process.exit(main());
