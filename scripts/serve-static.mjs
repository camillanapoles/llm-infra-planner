#!/usr/bin/env node
/**
 * Static file server for a built artifact — the local stand-in for nginx
 * (Docker image) and GitHub Pages. It also proxies /api/* to the WASI runtime
 * host, so a production build can be verified end-to-end on a laptop.
 *
 *   npm run build && npm run serve                    # serves ./dist
 *   node scripts/serve-static.mjs _site --port 8080   # serves the Pages artifact
 *   node scripts/serve-static.mjs _site/dev           # serves one environment
 *
 * Behaviour:
 *   - SPA fallback: unknown paths without an extension → index.html (200)
 *   - deep links inside a sub-path → that sub-path's 404.html, like Pages does
 *   - correct MIME types for .wasm, .json, .woff2 (wasm must be application/wasm)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dirArg = args.find(a => !a.startsWith('--')) ?? 'dist';
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '0.0.0.0';
const WASI_TARGET = process.env.WASI_PROXY_TARGET ?? 'http://127.0.0.1:8787';
const rootDir = path.resolve(root, dirArg);

if (!fs.existsSync(rootDir)) {
  console.error(`✖ ${dirArg} not found — run \`npm run build\` (or build-pages-artifact.mjs) first.`);
  process.exit(1);
}

// Longest-prefix base path detection (mounts /staging/, /dev/ for the Pages artifact)
const mounts = [''];
for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
  if (entry.isDirectory() && fs.existsSync(path.join(rootDir, entry.name, 'index.html'))) {
    mounts.push(`/${entry.name}/`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function mountFor(pathname) {
  const match = mounts.filter(m => m && pathname.startsWith(m)).sort((a, b) => b.length - a.length)[0];
  return match ?? '';
}

async function proxyToWasi(req, res, pathname) {
  const target = new URL(WASI_TARGET);
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, path: pathname + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), method: req.method, headers: { ...req.headers, host: target.host } },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'WASI runtime unreachable', hint: 'npm run wasi:serve' }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    void proxyToWasi(req, res, pathname);
    return;
  }

  const mount = mountFor(pathname);
  const rel = pathname.slice(mount.length) || '/';
  const filePath = path.join(rootDir, mount, rel);
  const safe = filePath.startsWith(path.join(rootDir, mount)) ? filePath : path.join(rootDir, mount);

  let target = safe;
  if (fs.existsSync(safe) && fs.statSync(safe).isDirectory()) target = path.join(safe, 'index.html');
  if (!fs.existsSync(target)) {
    // Pages-style fallback: extension-less paths get the SPA shell / 404.html
    const fallback = path.extname(pathname) === ''
      ? path.join(rootDir, mount, 'index.html')
      : path.join(rootDir, mount, '404.html');
    target = fs.existsSync(fallback) ? fallback : path.join(rootDir, mount, 'index.html');
  }

  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': path.extname(target) === '.html' ? 'no-store' : 'public, max-age=3600',
    'access-control-allow-origin': '*',
  });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  LLMcalc static server → http://${HOST}:${PORT}`);
  console.log(`  root   : ${path.relative(root, rootDir) || '.'}`);
  console.log(`  mounts : ${mounts.map(m => `${m || '/'}`).join('  ')}`);
  console.log(`  /api/* → ${WASI_TARGET}\n`);
});
