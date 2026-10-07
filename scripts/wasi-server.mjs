#!/usr/bin/env node
/**
 * LLMcalc local WASI runtime host.
 *
 * Serves the calculation kernel as an HTTP API where every request is executed
 * *inside* the WASI module (`wasi/dist/llmcalc-wasi.wasm`) by Node's built-in
 * preview1 host. This is the same module you would upload to a WASI runtime
 * (wasmtime, WasmEdge, Fermyon Spin, wasmCloud) — see `.kiro/specs/12-wasi-runtime.md`.
 *
 *   npm run wasi:serve                # http://0.0.0.0:8787
 *   PORT=9000 npm run wasi:serve
 *
 * Endpoints:
 *   GET  /health, /api/health runtime + module status
 *   GET  /api/selftest        deterministic kernel checks (JSON)
 *   GET  /api/plan?...        weightsGB, kvGB, overheadGB, tps, hourlyUsd
 *   GET  /api/kv?...          layers, batch, seq, kvHeads, headDim, bytes, attn, mlaDim
 *   GET  /api/roofline?...    bw, activeWeights, eff
 *   GET  /api/gpus?...        required, vramPerGpu, usable
 *   GET  /api/latency?...     ttft, tpot, outputTokens
 *   POST /api/compute         { command, args: [...] }
 *   GET  /                    status dashboard (runs the module server-side)
 *   GET  /wasm/*.wasm         the built modules themselves
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleInfo, runWasi, runWasiJson, wasiAvailable, KERNEL_MODULE_PATH, WASI_MODULE_PATH } from './lib/wasi-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WASI_PORT ?? process.env.PORT ?? 8787);
const HOST = process.env.WASI_HOST ?? '0.0.0.0';

const COMMAND_ARGS = {
  plan: ['weightsGB', 'kvGB', 'overheadGB', 'tps', 'hourlyUsd'],
  kv: ['layers', 'batch', 'seq', 'kvHeads', 'headDim', 'bytes', 'attn', 'mlaDim'],
  roofline: ['bw', 'activeWeights', 'eff'],
  gpus: ['required', 'vramPerGpu', 'usable'],
  latency: ['ttft', 'tpot', 'outputTokens'],
  selftest: [],
  info: [],
};

function send(res, status, body, contentType = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

function paramsToArgs(command, params) {
  const keys = COMMAND_ARGS[command];
  if (!keys) return null;
  const args = [command];
  for (const key of keys) {
    const value = params.get(key);
    if (value === null || value === '') break; // trailing params may be omitted
    args.push(value);
  }
  return args;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const runtimeStatus = () => ({
  ok: true,
  service: 'llmcalc-wasi-runtime',
  runtime: `node ${process.version} · node:wasi (preview1)`,
  pid: process.pid,
  uptimeSeconds: Math.round(process.uptime()),
  module: wasiAvailable() ? moduleInfo() : { available: false, hint: 'run npm run build:wasm' },
});

function dashboardHtml(status) {
  const module = status.module;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LLMcalc · WASI runtime</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b0f19; color:#e6edf7; padding:40px 20px; }
  .wrap { max-width:860px; margin:0 auto }
  h1 { font-size:22px; margin:0 0 4px } .muted { color:#8b98ad }
  .card { background:#121a2b; border:1px solid #223050; border-radius:12px; padding:18px 20px; margin:18px 0 }
  .pill { display:inline-block; background:#14351f; color:#5ee08a; border-radius:999px; padding:2px 10px; font-size:12px }
  code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
  pre { background:#0a1120; border:1px solid #1e2b47; border-radius:10px; padding:14px; overflow:auto }
  button { background:#2f6fed; color:#fff; border:0; border-radius:8px; padding:9px 14px; font-weight:600; cursor:pointer }
  a { color:#7fb2ff }
  table { width:100%; border-collapse:collapse } td { padding:6px 0; border-bottom:1px solid #1e2b47 }
  td:last-child { text-align:right; font-family:ui-monospace,monospace }
</style></head>
<body><div class="wrap">
  <h1>LLMcalc WASI runtime <span class="pill">running</span></h1>
  <p class="muted">WebAssembly <code>wasm32-wasi-preview1</code> command module executed by
  <code>node:wasi</code>. The browser page talks to this host through <code>/api/*</code>.</p>

  <div class="card">
    <table>
      <tr><td>Module</td><td>${module.available ? path.basename(module.path) : 'not built'}</td></tr>
      <tr><td>Size</td><td>${module.available ? (module.bytes / 1024).toFixed(2) + ' kB' : '—'}</td></tr>
      <tr><td>Host imports</td><td>${module.available ? module.imports.join(', ') : '—'}</td></tr>
      <tr><td>Kernel</td><td>${fs.existsSync(KERNEL_MODULE_PATH) ? (fs.statSync(KERNEL_MODULE_PATH).size / 1024).toFixed(2) + ' kB (browser)' : 'not built'}</td></tr>
      <tr><td>Runtime</td><td>${status.runtime}</td></tr>
    </table>
  </div>

  <div class="card">
    <p style="margin-top:0"><strong>Run the kernel inside the WASI runtime</strong></p>
    <p class="muted">8B model · FP16 · 32 layers · 4K context</p>
    <button onclick="run()">POST /api/plan</button>
    <pre id="out">—</pre>
  </div>

  <p class="muted">API: <code>/health</code> · <code>/api/health</code> · <code>/api/selftest</code> ·
  <code>/api/plan</code> · <code>/api/kv</code> · <code>/api/roofline</code> ·
  <code>/api/gpus</code> · <code>/api/latency</code> · <code>POST /api/compute</code></p>
<script>
  async function run() {
    const el = document.getElementById('out');
    el.textContent = 'executing wasm…';
    const res = await fetch('/api/plan?weightsGB=16&kvGB=0.54&overheadGB=0.5&tps=1500&hourlyUsd=2.49');
    el.textContent = JSON.stringify(await res.json(), null, 2);
  }
</script>
</div></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (pathname === '/' ) {
      return send(res, 200, dashboardHtml(runtimeStatus()), 'text/html');
    }

    // `/health` for orchestrators (docker HEALTHCHECK, k8s probes) and
    // `/api/health` for the page — both describe the same runtime.
    if (pathname === '/health' || pathname === '/api/health') {
      const status = runtimeStatus();
      status.status = status.module.available ? 'ready' : 'module-missing';
      return send(res, status.module.available ? 200 : 503, status);
    }

    if (pathname.startsWith('/wasm/')) {
      const file = path.join(root, 'public', 'wasm', path.basename(pathname));
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: 'not found' });
      return send(res, 200, fs.readFileSync(file), 'application/wasm');
    }

    if (pathname === '/api/compute' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return send(res, 400, { ok: false, error: 'invalid JSON body' });
      const { command, args = [] } = body;
      if (!COMMAND_ARGS[command]) return send(res, 400, { ok: false, error: `unknown command "${command}"` });
      const result = await runWasiJson([command, ...args]);
      return send(res, result.ok ? 200 : 400, result);
    }

    const match = /^\/api\/([a-z]+)$/.exec(pathname);
    if (match) {
      const command = match[1];
      const query = new URLSearchParams(url.search);
      let args;

      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { ok: false, error: 'invalid JSON body' });
        if (body.args) args = [command, ...body.args];
        else args = paramsToArgs(command, new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])));
      } else {
        args = paramsToArgs(command, query);
      }

      if (!args) return send(res, 404, { ok: false, error: `unknown command "${command}"` });
      const result = await runWasiJson(args);
      return send(res, result.ok ? 200 : 400, result);
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(PORT, HOST, () => {
  const info = wasiAvailable() ? moduleInfo() : null;
  console.log(`\n  LLMcalc WASI runtime → http://${HOST}:${PORT}`);
  console.log(`  runtime: node ${process.version} (node:wasi, preview1)`);
  console.log(`  module : ${info ? `${path.basename(WASI_MODULE_PATH)} · ${(info.bytes / 1024).toFixed(2)} kB · imports: ${info.imports.join(', ')}` : 'not built — run npm run build:wasm'}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
