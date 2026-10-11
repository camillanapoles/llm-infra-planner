/**
 * Continuity store — the mutable half of the project state.
 *
 * `roadmap.json` / `policy.json` are declarations (reviewed in PRs); this store is
 * the **ledger**: sessions, events, gate runs, key/value notes the agent sets and
 * recovers, and mirrors of the tasks/handoffs for querying.
 *
 * Design (three patterns, on purpose):
 *
 *   META CLASS   `EntityMeta` describes a table once (columns, types, pk, defaults,
 *                validation, secret scanning). Everything else — DDL, coercion,
 *                query building — is derived from that metadata, so a new
 *                collection is a declaration, not code.
 *   FACTORY      `defineEntity()` produces those metas; `createStore()` picks the
 *                driver; `repositories()` builds the typed CRUD facades.
 *   REPOSITORY   `Repository<T>` is the only way to touch data: insert/get/list/
 *                update/upsert/remove/query — no SQL string escapes the module.
 *
 * Drivers: SQLite (`node:sqlite`, the local ledger) and JSON (fallback + the
 * snapshot committed to git, so the ledger survives a wiped sandbox without
 * binary merge conflicts).
 *
 * The store never holds credentials: `scanForSecrets()` rejects token-shaped
 * values, and `checkStore()` runs it over every collection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const STORE_FILE = '.kiro/state/continuity.db';
export const SNAPSHOT_FILE = '.kiro/state/store.json';
export const PUBLIC_SNAPSHOT_FILE = 'public/store.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ColumnType = 'text' | 'integer' | 'real' | 'json' | 'bool';
export type Row = Record<string, unknown>;

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  pk?: boolean;
  required?: boolean;
  default?: unknown;
  /** Rows are scanned for secrets unless the value is exempt (e.g. a note *about* tokens). */
  secretScan?: boolean;
}

export interface EntitySpec {
  table: string;
  columns: ColumnMeta[];
  /** Human description — surfaced by `store check` and the API. */
  description: string;
}

export type Operator = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | 'in';

export interface QuerySpec {
  where?: Partial<Record<string, { op: Operator; value: unknown } | unknown>>;
  order?: { column: string; direction?: 'asc' | 'desc' } | string;
  limit?: number;
  offset?: number;
}

// ─── Meta class ──────────────────────────────────────────────────────────────

/** Identifiers are interpolated in DDL/DML, so they must never be SQL keywords. */
const RESERVED_SQL = new Set([
  'select', 'from', 'where', 'insert', 'update', 'delete', 'table', 'index', 'order', 'group', 'by',
  'commit', 'rollback', 'begin', 'transaction', 'primary', 'foreign', 'references', 'default', 'values',
  'and', 'or', 'not', 'null', 'in', 'like', 'limit', 'offset', 'join', 'union', 'distinct', 'set',
]);

export class EntityMeta<T extends Row = Row> {
  readonly table: string;
  readonly description: string;
  readonly columns: readonly ColumnMeta[];
  readonly pk: ColumnMeta;

  constructor(spec: EntitySpec) {
    if (!spec.columns.length) throw new Error(`entidade "${spec.table}" sem colunas`);
    const pks = spec.columns.filter(column => column.pk);
    if (pks.length !== 1) throw new Error(`entidade "${spec.table}" precisa de exatamente uma coluna pk (tem ${pks.length})`);
    const names = new Set<string>();
    for (const column of spec.columns) {
      if (names.has(column.name)) throw new Error(`entidade "${spec.table}" repete a coluna "${column.name}"`);
      if (RESERVED_SQL.has(column.name.toLowerCase())) {
        throw new Error(`entidade "${spec.table}": "${column.name}" é palavra reservada de SQL — use outro nome (ex.: commit_sha)`);
      }
      if (!/^[a-z_][a-z0-9_]*$/.test(column.name)) {
        throw new Error(`entidade "${spec.table}": coluna "${column.name}" precisa ser snake_case minúsculo`);
      }
      names.add(column.name);
    }
    this.table = spec.table;
    this.description = spec.description;
    this.columns = spec.columns;
    this.pk = pks[0];
  }

  column(name: string): ColumnMeta {
    const found = this.columns.find(column => column.name === name);
    if (!found) throw new Error(`coluna desconhecida em "${this.table}": ${name} (conhecidas: ${this.names().join(', ')})`);
    return found;
  }

  names(): string[] {
    return this.columns.map(column => column.name);
  }

  /** DDL derived from the metadata — the single place that knows about SQL types. */
  ddl(): string {
    const typeOf = (column: ColumnMeta): string =>
      column.type === 'integer' || column.type === 'bool' ? 'INTEGER' : column.type === 'real' ? 'REAL' : 'TEXT';
    const parts = this.columns.map(column => {
      const bits = [column.name, typeOf(column)];
      if (column.pk) bits.push('PRIMARY KEY');
      if (column.required && !column.pk) bits.push('NOT NULL');
      return bits.join(' ');
    });
    return `CREATE TABLE IF NOT EXISTS ${this.table} (${parts.join(', ')})`;
  }

  /** Structured columns need serialization; everything else is stored natively. */
  encode(row: Row): Row {
    const out: Row = {};
    for (const column of this.columns) {
      if (!(column.name in row)) continue;
      const value = row[column.name];
      if (value === undefined) continue;
      if (column.type === 'json') out[column.name] = JSON.stringify(value ?? null);
      else if (column.type === 'bool') out[column.name] = value ? 1 : 0;
      else out[column.name] = value;
    }
    return out;
  }

  decode(row: Row): T {
    const out: Row = {};
    for (const column of this.columns) {
      const value = row[column.name];
      if (column.type === 'json') {
        try {
          out[column.name] = typeof value === 'string' && value !== '' ? JSON.parse(value) : null;
        } catch {
          out[column.name] = null;
        }
      } else if (column.type === 'bool') out[column.name] = Boolean(value);
      else out[column.name] = value ?? null;
    }
    return out as T;
  }

  /** Defaults + type check. Throws with a readable message — the caller decides the exit path. */
  coerce(row: Row): Row {
    const out: Row = {};
    for (const column of this.columns) {
      const provided = row[column.name];
      const value = provided === undefined || provided === null || provided === '' ? column.default : provided;
      if (column.required && (value === undefined || value === null)) {
        throw new Error(`${this.table}.${column.name} é obrigatório`);
      }
      if (value === undefined) continue;
      if (column.type === 'integer' && typeof value === 'string' && !/^-?\d+$/.test(value)) {
        throw new Error(`${this.table}.${column.name} espera inteiro, recebeu "${value}"`);
      }
      if (column.type === 'bool' && typeof value === 'string' && !/^(true|false|0|1|yes|no)$/i.test(value)) {
        throw new Error(`${this.table}.${column.name} espera booleano, recebeu "${value}"`);
      }
      out[column.name] = column.type === 'integer' && typeof value === 'string' ? Number(value) : column.type === 'bool' && typeof value === 'string' ? /^(true|1|yes)$/i.test(value) : value;
    }
    return out;
  }

  findSecret(row: Row): { column: string; reason: string } | null {
    for (const column of this.columns) {
      if (column.secretScan === false) continue;
      const value = row[column.name];
      const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
      const hit = scanForSecrets(text)[0];
      if (hit) return { column: column.name, reason: hit };
    }
    return null;
  }
}

/** Factory of metas: one declaration per collection. */
export function defineEntity(spec: EntitySpec): EntityMeta {
  return new EntityMeta(spec);
}

// ─── Secret scanning (the store is text people write freely into) ────────────

const SECRET_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/, reason: 'token do GitHub' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, reason: 'fine-grained PAT' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: 'chave de acesso AWS' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'chave privada' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: 'token do Slack' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}/, reason: 'token do GitLab' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/, reason: 'chave de API' },
];

/** Returns the human reasons a string looks like a credential (empty = clean). */
export function scanForSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ reason }) => reason);
}

// ─── Drivers ─────────────────────────────────────────────────────────────────

export interface Driver {
  readonly kind: 'sqlite' | 'json';
  exec(sql: string): void;
  run(sql: string, params: unknown[]): void;
  all(sql: string, params: unknown[]): Row[];
  get(sql: string, params: unknown[]): Row | undefined;
  close(): void;
  readonly file: string;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

class SqliteDriver implements Driver {
  readonly kind = 'sqlite' as const;
  private readonly db: SqliteDatabase;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDatabase };
    this.db = new sqlite.DatabaseSync(file);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
  run(sql: string, params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }
  all(sql: string, params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  get(sql: string, params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  close(): void {
    this.db.close();
  }
}

/** JSON driver: same semantics, one file, atomic writes — the portable fallback. */
class JsonDriver implements Driver {
  readonly kind = 'json' as const;
  private data: { tables: Record<string, Row[]> };

  constructor(readonly file: string) {
    this.data = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { tables: Record<string, Row[]> }) : { tables: {} };
    this.data.tables ??= {};
  }

  exec(sql: string): void {
    const match = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql);
    if (match) this.data.tables[match[1]] ??= [];
  }
  run(sql: string, params: unknown[]): void {
    const insert = /^INSERT INTO (\w+) \(([^)]+)\)/i.exec(sql.trim());
    if (insert) {
      const [, table, columnList] = insert;
      const columns = columnList.split(',').map(column => column.trim());
      const row: Row = {};
      columns.forEach((column, index) => (row[column] = params[index]));
      this.data.tables[table] ??= [];
      // upsert semantics: replace by pk when the shape is `INSERT ... ON CONFLICT`
      if (/ON CONFLICT/i.test(sql)) {
        const pk = columns[0];
        const index = this.data.tables[table].findIndex(existing => existing[pk] === row[pk]);
        if (index >= 0) {
          this.data.tables[table][index] = { ...this.data.tables[table][index], ...row };
          this.flush();
          return;
        }
      }
      this.data.tables[table].push(row);
      this.flush();
      return;
    }
    const update = /^UPDATE (\w+) SET (.+) WHERE (.+)$/i.exec(sql.trim());
    if (update) {
      const [, table, assignments, whereClause] = update;
      const columns = assignments.split(',').map(part => part.split('=')[0].trim());
      const whereColumns = whereClause.split(/\s+AND\s+/i).map(part => part.split('=')[0].trim());
      const whereValues = params.slice(columns.length);
      for (const row of this.data.tables[table] ?? []) {
        if (whereColumns.every((column, index) => row[column] === whereValues[index])) {
          columns.forEach((column, index) => (row[column] = params[index]));
        }
      }
      this.flush();
      return;
    }
    const remove = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(sql.trim());
    if (remove) {
      const [, table, whereClause] = remove;
      const whereColumns = whereClause.split(/\s+AND\s+/i).map(part => part.split('=')[0].trim());
      this.data.tables[table] = (this.data.tables[table] ?? []).filter(row => !whereColumns.every((column, index) => row[column] === params[index]));
      this.flush();
      return;
    }
    throw new Error(`JsonDriver não sabe executar: ${sql.slice(0, 80)}`);
  }
  all(sql: string, params: unknown[]): Row[] {
    const match = /^SELECT \* FROM (\w+)(.*)$/is.exec(sql.trim());
    if (!match) throw new Error(`JsonDriver não sabe consultar: ${sql.slice(0, 80)}`);
    const [, table, tail] = match;
    let rows = [...(this.data.tables[table] ?? [])];
    const where = /WHERE (.+?)(?: ORDER BY| LIMIT| OFFSET|$)/is.exec(tail)?.[1];
    if (where) {
      const clause = where.replace(/ ORDER BY[\s\S]*$/i, '');
      const conditions = clause.split(/\s+AND\s+/i);
      let paramIndex = 0;
      const tests = conditions.map(condition => {
        const like = /^(\w+) LIKE \?$/i.exec(condition.trim());
        if (like) {
          const value = String(params[paramIndex++]).replaceAll('%', '');
          return { column: like[1], test: (cell: unknown) => String(cell ?? '').toLowerCase().includes(value.toLowerCase()) };
        }
        const inClause = /^(\w+) IN \(([^)]*)\)$/i.exec(condition.trim());
        if (inClause) {
          const count = inClause[2].split(',').length;
          const values = params.slice(paramIndex, paramIndex + count).map(String);
          paramIndex += count;
          return { column: inClause[1], test: (cell: unknown) => values.includes(String(cell)) };
        }
        const compare = /^(\w+)\s*(=|!=|>=|<=|>|<)\s*\?$/i.exec(condition.trim());
        if (compare) {
          const value = params[paramIndex++];
          const op = compare[2];
          return {
            column: compare[1],
            test: (cell: unknown) => {
              if (op === '=') return cell === value;
              if (op === '!=') return cell !== value;
              const left = typeof cell === 'number' ? cell : String(cell ?? '');
              const right = typeof value === 'number' ? value : String(value ?? '');
              return op === '>' ? left > right : op === '>=' ? left >= right : op === '<' ? left < right : left <= right;
            },
          };
        }
        throw new Error(`JsonDriver não entende a condição: ${condition}`);
      });
      rows = rows.filter(row => tests.every(({ column, test }) => test(row[column])));
    }
    const order = /ORDER BY (\w+) DESC/is.exec(tail);
    if (order) rows.sort((a, b) => String(b[order[1]] ?? '').localeCompare(String(a[order[1]] ?? '')));
    else {
      const asc = /ORDER BY (\w+) ASC/is.exec(tail);
      if (asc) rows.sort((a, b) => String(a[asc[1]] ?? '').localeCompare(String(b[asc[1]] ?? '')));
    }
    const limit = /LIMIT (\d+)/i.exec(tail);
    const offset = /OFFSET (\d+)/i.exec(tail);
    const start = offset ? Number(offset[1]) : 0;
    if (limit) rows = rows.slice(start, start + Number(limit[1]));
    else if (start) rows = rows.slice(start);
    return rows;
  }
  get(sql: string, params: unknown[]): Row | undefined {
    return this.all(sql, params)[0];
  }
  close(): void {
    this.flush();
  }
  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}

export function detectDriver(): 'sqlite' | 'json' {
  try {
    const require = createRequire(import.meta.url);
    require('node:sqlite');
    return 'sqlite';
  } catch {
    return 'json';
  }
}

export interface Store {
  readonly driver: Driver;
  readonly file: string;
}

/** Factory: one call, the right driver, the schema applied idempotently. */
export function createStore(input: { file: string; driver?: 'auto' | 'sqlite' | 'json'; entities?: EntityMeta[]; silent?: boolean }): Store {
  const requested = input.driver ?? 'auto';
  let kind: 'sqlite' | 'json' = requested === 'auto' ? detectDriver() : requested;
  if (kind === 'sqlite' && requested !== 'json') {
    try {
      // probe: the module may exist but refuse to open (old kernel, read-only fs)
      const probe = new SqliteDriver(input.file);
      probe.close();
    } catch {
      kind = 'json';
    }
  }
  const driver: Driver = kind === 'sqlite' ? new SqliteDriver(input.file) : new JsonDriver(`${input.file.replace(/\.db$/, '')}.json`);
  for (const entity of input.entities ?? ENTITIES) driver.exec(entity.ddl());
  return { driver, file: driver.file };
}

// ─── Repository ──────────────────────────────────────────────────────────────

/** Coerces a filter value to what the column actually stores (bool → 1/0, int → number). */
function coerceFilterValue(column: ColumnMeta, value: unknown): unknown {
  if (column.type === 'bool') return value === true || /^(true|1|yes|ok)$/i.test(String(value)) ? 1 : 0;
  if (column.type === 'integer') return typeof value === 'number' ? value : Number(value);
  return value;
}

export function buildQuery(meta: EntityMeta, spec: QuerySpec): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  for (const [column, condition] of Object.entries(spec.where ?? {})) {
    const meta_column = meta.column(column); // throws on anything not declared — the injection guard
    const { op, value } = condition && typeof condition === 'object' && 'op' in condition ? (condition as { op: Operator; value: unknown }) : { op: '=' as Operator, value: condition };
    if (op === 'in') {
      const values = (Array.isArray(value) ? value : String(value).split('|')).map(item => coerceFilterValue(meta_column, item));
      if (!values.length) continue;
      conditions.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    } else if (op === '~') {
      conditions.push(`${column} LIKE ?`);
      params.push(`%${String(value)}%`);
    } else {
      conditions.push(`${column} ${op} ?`);
      params.push(coerceFilterValue(meta_column, value));
    }
  }
  const order = typeof spec.order === 'string' ? { column: spec.order, direction: 'asc' as const } : spec.order;
  let sql = `SELECT * FROM ${meta.table}`;
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  if (order) {
    meta.column(order.column);
    sql += ` ORDER BY ${order.column} ${(order.direction ?? 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
  }
  if (spec.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(spec.limit))}`;
  if (spec.offset !== undefined) sql += ` OFFSET ${Math.max(0, Math.floor(spec.offset))}`;
  return { sql, params };
}

export class Repository<T extends Row = Row> {
  constructor(readonly meta: EntityMeta<T>, private readonly driver: Driver) {}

  insert(row: Row): T {
    const coerced = this.meta.coerce(row);
    const secret = this.meta.findSecret(coerced);
    if (secret) throw new Error(`recusado: ${this.meta.table}.${secret.column} parece ${secret.reason} — o store nunca guarda credencial`);
    const encoded = this.meta.encode(coerced);
    const columns = Object.keys(encoded);
    this.driver.run(`INSERT INTO ${this.meta.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => encoded[column]));
    return this.meta.decode(encoded);
  }

  /** Insert-or-replace by primary key — the idempotent path used by sync. */
  upsert(row: Row): T {
    const coerced = this.meta.coerce(row);
    const secret = this.meta.findSecret(coerced);
    if (secret) throw new Error(`recusado: ${this.meta.table}.${secret.column} parece ${secret.reason} — o store nunca guarda credencial`);
    const encoded = this.meta.encode(coerced);
    const columns = Object.keys(encoded);
    const updates = columns.filter(column => column !== this.meta.pk.name).map(column => `${column} = excluded.${column}`);
    const sql = `INSERT INTO ${this.meta.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})${
      updates.length ? ` ON CONFLICT(${this.meta.pk.name}) DO UPDATE SET ${updates.join(', ')}` : ''
    }`;
    this.driver.run(sql, columns.map(column => encoded[column]));
    return this.meta.decode(encoded);
  }

  get(id: unknown): T | null {
    const row = this.driver.get(`SELECT * FROM ${this.meta.table} WHERE ${this.meta.pk.name} = ?`, [id]);
    return row ? this.meta.decode(row) : null;
  }

  list(spec: QuerySpec = {}): T[] {
    const { sql, params } = buildQuery(this.meta, spec);
    return this.driver.all(sql, params).map(row => this.meta.decode(row));
  }

  query(spec: QuerySpec = {}): T[] {
    return this.list(spec);
  }

  update(id: unknown, patch: Row): { updated: boolean; row: T | null } {
    const changes = this.meta.coerce({ ...this.get(id), ...patch });
    const secret = this.meta.findSecret(changes);
    if (secret) throw new Error(`recusado: ${this.meta.table}.${secret.column} parece ${secret.reason}`);
    const existing = this.get(id);
    if (!existing) return { updated: false, row: null };
    const encoded = this.meta.encode({ ...changes, [this.meta.pk.name]: id });
    const columns = Object.keys(encoded).filter(column => column !== this.meta.pk.name);
    this.driver.run(`UPDATE ${this.meta.table} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE ${this.meta.pk.name} = ?`, [...columns.map(column => encoded[column]), id]);
    return { updated: true, row: this.get(id) };
  }

  remove(id: unknown): boolean {
    const before = this.get(id);
    if (!before) return false;
    this.driver.run(`DELETE FROM ${this.meta.table} WHERE ${this.meta.pk.name} = ?`, [id]);
    return true;
  }

  count(spec: QuerySpec = {}): number {
    return this.list({ ...spec, limit: undefined, offset: undefined }).length;
  }
}

// ─── The project's collections (meta registry) ───────────────────────────────

export const ENTITIES: EntityMeta[] = [
  defineEntity({
    table: 'sessions',
    description: 'uma sessão de trabalho (humana ou agente): onde começou, o que buscava, onde parou',
    columns: [
      { name: 'id', type: 'text', pk: true, required: true },
      { name: 'branch', type: 'text', required: true },
      { name: 'agent', type: 'text', default: 'unknown' },
      { name: 'goal', type: 'text', default: '' },
      { name: 'started_at', type: 'text', required: true },
      { name: 'heartbeat_at', type: 'text' },
      { name: 'ended_at', type: 'text' },
      { name: 'resume_point', type: 'text', default: '' },
      { name: 'blockers', type: 'json', default: [] },
      { name: 'next_tasks', type: 'json', default: [] },
    ],
  }),
  defineEntity({
    table: 'kv',
    description: 'objeto que a sessão seta e recupera (notas, ponteiros, decisões)',
    columns: [
      { name: 'key', type: 'text', pk: true, required: true },
      { name: 'value', type: 'json', required: true },
      { name: 'updated_at', type: 'text', required: true },
      { name: 'updated_by', type: 'text', default: 'unknown' },
    ],
  }),
  defineEntity({
    table: 'events',
    description: 'jornal append-only: o que aconteceu, na ordem',
    columns: [
      { name: 'id', type: 'text', pk: true, required: true },
      { name: 'at', type: 'text', required: true },
      { name: 'type', type: 'text', required: true },
      { name: 'branch', type: 'text', default: '' },
      { name: 'summary', type: 'text', required: true },
      { name: 'data', type: 'json', default: {} },
    ],
  }),
  defineEntity({
    table: 'gates',
    description: 'resultado de cada verificação (gate como dado, não como print)',
    columns: [
      { name: 'id', type: 'text', pk: true, required: true },
      { name: 'ran_at', type: 'text', required: true },
      { name: 'ok', type: 'bool', required: true },
      { name: 'detail', type: 'text', default: '' },
      { name: 'commit_sha', type: 'text', default: '' },
      { name: 'branch', type: 'text', default: '' },
    ],
  }),
  defineEntity({
    table: 'tasks',
    description: 'espelho consultável do roadmap',
    columns: [
      { name: 'id', type: 'text', pk: true, required: true },
      { name: 'phase', type: 'text', default: '' },
      { name: 'title', type: 'text', required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'spec', type: 'text', default: '' },
      { name: 'evidence', type: 'text', default: '' },
      { name: 'updated_at', type: 'text' },
    ],
  }),
  defineEntity({
    table: 'handoffs',
    description: 'espelho consultável dos handoffs por branch',
    columns: [
      { name: 'branch', type: 'text', pk: true, required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'tasks', type: 'json', default: [] },
      { name: 'specs', type: 'json', default: [] },
      { name: 'paths', type: 'integer', default: 0 },
      { name: 'resume_point', type: 'text', default: '' },
      { name: 'updated_at', type: 'text' },
    ],
  }),
  defineEntity({
    table: 'artifacts',
    description: 'o que foi construído/verificado, com onde encontrá-lo',
    columns: [
      { name: 'id', type: 'text', pk: true, required: true },
      { name: 'kind', type: 'text', required: true },
      { name: 'path', type: 'text', default: '' },
      { name: 'size_kb', type: 'real' },
      { name: 'commit_sha', type: 'text', default: '' },
      { name: 'built_at', type: 'text' },
    ],
  }),
];

/** Repository for any collection by (loose) name — keeps the CLI free of casts. */
export function repositoryFor(repos: Repositories, name: string): Repository {
  return new Repository(entityByTable(name), repos.driver);
}

export function entityByTable(table: string): EntityMeta {
  const found = ENTITIES.find(entity => entity.table === table || entity.table === `${table}s` || entity.table.replace(/s$/, '') === table);
  if (!found) throw new Error(`coleção desconhecida: ${table} (conhecidas: ${ENTITIES.map(entity => entity.table).join(', ')})`);
  return found;
}

export interface Repositories {
  driver: Driver;
  sessions: Repository;
  kv: Repository;
  events: Repository;
  gates: Repository;
  tasks: Repository;
  handoffs: Repository;
  artifacts: Repository;
}

/** Factory of facades: one repository per collection, same driver. */
export function repositories(store: Store): Repositories {
  const make = (table: string): Repository => new Repository(entityByTable(table), store.driver);
  return {
    driver: store.driver,
    sessions: make('sessions'),
    kv: make('kv'),
    events: make('events'),
    gates: make('gates'),
    tasks: make('tasks'),
    handoffs: make('handoffs'),
    artifacts: make('artifacts'),
  };
}

// ─── Convenience operations (the "functions" of the gates) ───────────────────

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Gate as a function: verify → record → report. Used by both CLI and CI. */
/** Gate as a function: run → record → report. A gate result is a row, not a print. */
export function recordGate(
  repos: Repositories,
  input: { id: string; ok: boolean; detail?: string; commit?: string; branch?: string; ranAt?: string },
): Row {
  const ranAt = input.ranAt ?? nowIso();
  return repos.gates.upsert({
    id: `${input.id}@${ranAt}`,
    ran_at: ranAt,
    ok: input.ok,
    detail: input.detail ?? '',
    commit_sha: input.commit ?? '',
    branch: input.branch ?? '',
  });
}

export function gatesSummary(repos: Repositories, limit = 20): { total: number; failed: number; recent: Row[] } {
  const recent = repos.gates.list({ order: { column: 'ran_at', direction: 'desc' }, limit });
  const failed = repos.gates.list({ where: { ok: { op: '=', value: 0 } } }).length;
  return { total: repos.gates.count(), failed, recent };
}

export function recordEvent(repos: Repositories, input: { type: string; summary: string; branch?: string; data?: Row }): Row {
  const at = nowIso();
  return repos.events.upsert({ id: `${input.type}_${at}_${Math.random().toString(36).slice(2, 6)}`, at, type: input.type, branch: input.branch ?? '', summary: input.summary, data: input.data ?? {} });
}

/** `kv` is the set/get object: any JSON value, timestamped, no ceremony. */
export function kvSet(repos: Repositories, key: string, value: unknown, by = 'unknown'): Row {
  return repos.kv.upsert({ key, value, updated_at: nowIso(), updated_by: by });
}
export function kvGet(repos: Repositories, key: string): unknown {
  const row = repos.kv.get(key);
  return row ? row.value : null;
}

export function startSession(repos: Repositories, input: { branch: string; agent?: string; goal?: string; id?: string }): Row {
  const started = nowIso();
  return repos.sessions.upsert({
    id: input.id ?? `${input.branch.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@${started.slice(0, 10)}`,
    branch: input.branch,
    agent: input.agent ?? 'unknown',
    goal: input.goal ?? '',
    started_at: started,
    heartbeat_at: started,
    ended_at: null,
    resume_point: '',
    blockers: [],
    next_tasks: [],
  });
}

export function touchSession(repos: Repositories, id: string, patch: Row = {}): Row | null {
  const row = repos.sessions.get(id);
  if (!row) return null;
  return repos.sessions.update(id, { ...patch, heartbeat_at: nowIso() }).row;
}

export function latestSession(repos: Repositories): Row | null {
  return repos.sessions.list({ order: { column: 'started_at', direction: 'desc' }, limit: 1 })[0] ?? null;
}

// ─── Snapshot: the store's portable, committable form ────────────────────────

export interface Snapshot {
  schema: 1;
  kind: 'continuity-store-snapshot';
  generatedAt: string;
  driver: 'sqlite' | 'json';
  counts: Record<string, number>;
  tables: Record<string, Row[]>;
}

/** How much of each collection travels in the snapshot (newest first). */
const SNAPSHOT_LIMITS: Record<string, { order: string; limit?: number }> = {
  sessions: { order: 'started_at', limit: 50 },
  events: { order: 'at', limit: 200 },
  gates: { order: 'ran_at', limit: 100 },
  kv: { order: 'updated_at' },
  tasks: { order: 'id' },
  handoffs: { order: 'branch' },
  artifacts: { order: 'built_at', limit: 50 },
};

export function exportSnapshot(repos: Repositories, generatedAt = nowIso()): Snapshot {
  const counts: Record<string, number> = {};
  const tables: Record<string, Row[]> = {};
  for (const entity of ENTITIES) {
    const rule = SNAPSHOT_LIMITS[entity.table] ?? { order: entity.pk.name };
    const rows = new Repository(entity, repos.driver).list({ order: { column: rule.order, direction: 'desc' }, limit: rule.limit });
    tables[entity.table] = entity.table === 'tasks' || entity.table === 'handoffs' ? rows.reverse() : rows;
    counts[entity.table] = rows.length;
  }
  return { schema: 1, kind: 'continuity-store-snapshot', generatedAt, driver: repos.driver.kind, counts, tables };
}

export function writeSnapshot(repos: Repositories, files: { snapshot: string; publicSnapshot?: string }, generatedAt = nowIso()): Snapshot {
  const snapshot = exportSnapshot(repos, generatedAt);
  fs.mkdirSync(path.dirname(files.snapshot), { recursive: true });
  fs.writeFileSync(files.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (files.publicSnapshot) {
    fs.mkdirSync(path.dirname(files.publicSnapshot), { recursive: true });
    // the page consumes it through /api/store — same object, no secrets by construction
    fs.writeFileSync(files.publicSnapshot, `${JSON.stringify({ generatedAt: snapshot.generatedAt, counts: snapshot.counts, tables: { sessions: snapshot.tables.sessions, gates: snapshot.tables.gates.slice(0, 20), kv: snapshot.tables.kv, tasks: snapshot.tables.tasks } }, null, 2)}\n`);
  }
  return snapshot;
}

export function importSnapshot(repos: Repositories, snapshot: Snapshot): { imported: Record<string, number>; skipped: string[] } {
  const imported: Record<string, number> = {};
  const skipped: string[] = [];
  for (const [table, rows] of Object.entries(snapshot.tables ?? {})) {
    let meta: EntityMeta;
    try {
      meta = entityByTable(table);
    } catch {
      skipped.push(table); // snapshot de um schema mais novo: ignora o que não conhecemos
      continue;
    }
    const repository = new Repository(meta, repos.driver);
    for (const row of rows) {
      try {
        repository.upsert(row as Row);
      } catch {
        // linha que viola o schema atual é descartada — nunca coagida em silêncio
        imported[table] = (imported[table] ?? 0) - 1;
      }
    }
    imported[table] = rows.length;
  }
  return { imported, skipped };
}

// ─── Integrity: `store check` ────────────────────────────────────────────────

export interface StoreFinding {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
}

export function checkStore(repos: Repositories): StoreFinding[] {
  const findings: StoreFinding[] = [];
  let rows = 0;
  let secrets = 0;
  for (const entity of ENTITIES) {
    const repository = new Repository(entity, repos.driver);
    const all = repository.list({});
    rows += all.length;
    for (const row of all) {
      const hit = entity.findSecret(row as Row);
      if (hit) {
        secrets += 1;
        findings.push({ level: 'error', code: 'store-secret', message: `${entity.table}: ${hit.column} parece ${hit.reason} — credencial nunca entra no store` });
      }
    }
  }
  const stale = repos.gates.list({ order: { column: 'ran_at', direction: 'desc' }, limit: 1 })[0];
  if (!stale) findings.push({ level: 'warn', code: 'store-no-gates', message: 'nenhum gate registrado ainda (rode `npm run continuity:sync`)' });
  const session = latestSession(repos);
  if (!session) findings.push({ level: 'warn', code: 'store-no-session', message: 'nenhuma sessão registrada (rode `npm run store -- session start`)' });
  else if (!session.ended_at) findings.push({ level: 'info', code: 'store-session-open', message: `sessão aberta: ${String(session.id)} (${String(session.branch)})` });

  if (secrets === 0) {
    findings.push({ level: 'info', code: 'store-ok', message: `store íntegro: ${ENTITIES.length} coleções, ${rows} linha(s), nenhum segredo` });
  }
  return findings;
}
