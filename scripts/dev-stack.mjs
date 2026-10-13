#!/usr/bin/env node
/**
 * Local runtime stack — one command, two processes:
 *
 *   1. vite dev server (the page) on 0.0.0.0:$PORT (default 5173)
 *   2. WASI runtime host              on 0.0.0.0:$WASI_PORT (default 8787)
 *
 * `vite.config.ts` proxies `/api/*` to the WASI host, so the page can execute
 * plans inside the wasm module without the browser ever touching localhost.
 *
 *   npm run stack
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '5173';
const wasiPort = process.env.WASI_PORT ?? '8787';

const COLORS = { vite: '\x1b[36m', wasi: '\x1b[35m', reset: '\x1b[0m' };

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const prefix = `${COLORS[name]}${name.padEnd(4)}${COLORS.reset} │ `;
  const pipe = stream => {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', code => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 0);
  });
  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`
  LLMcalc local stack
  ───────────────────
  page  → http://0.0.0.0:${port}
  wasi  → http://0.0.0.0:${wasiPort}   (proxied at /api/*)
`);

children.push(start('wasi', process.execPath, ['scripts/wasi-server.mjs'], { WASI_PORT: wasiPort }));
children.push(start('vite', 'npx', ['vite', '--port', port, '--host', '0.0.0.0'], { PORT: port }));
