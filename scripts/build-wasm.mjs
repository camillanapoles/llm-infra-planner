#!/usr/bin/env node
/**
 * Builds both WebAssembly artifacts of the project:
 *
 *   1. public/wasm/llmcalc-kernel.wasm  — browser kernel (no imports, `runtime stub`)
 *   2. wasi/dist/llmcalc-wasi.wasm      — WASI preview1 command module (fd_write only)
 *
 * The WASI build is also copied to public/wasm/ so the static site can ship and
 * advertise the module (it is executed by scripts/wasi-server.mjs, not by the
 * browser, because browsers have no WASI host).
 *
 * Usage:  node scripts/build-wasm.mjs [--watch]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asc = path.join(root, 'node_modules', '.bin', 'asc');

const targets = [
  {
    name: 'kernel',
    entry: 'wasm/kernel.ts',
    out: 'public/wasm/llmcalc-kernel.wasm',
    flags: ['--runtime', 'stub'],
  },
  {
    name: 'wasi-service',
    entry: 'wasm/service.ts',
    out: 'wasi/dist/llmcalc-wasi.wasm',
    flags: ['--runtime', 'stub', '--use', 'abort='],
  },
];

function build(target) {
  const outPath = path.join(root, target.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const args = [
    path.join(root, target.entry),
    '-o', outPath,
    '-O3s',
    '--noAssert',
    '--enable', 'sign-extension',
    '--enable', 'mutable-globals',
    ...target.flags,
  ].filter(a => a !== undefined);

  const started = Date.now();
  execFileSync(asc, args, { cwd: root, stdio: 'pipe' });
  const stats = fs.statSync(outPath);
  const kb = (stats.size / 1024).toFixed(2);
  console.log(`✓ ${target.name.padEnd(14)} ${target.out.padEnd(34)} ${kb.padStart(7)} kB  (${Date.now() - started} ms)`);
  return stats.size;
}

function postProcess() {
  // Ship the WASI module next to the kernel so the static site can link to it.
  const src = path.join(root, 'wasi/dist/llmcalc-wasi.wasm');
  const dest = path.join(root, 'public/wasm/llmcalc-wasi.wasm');
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // Emit a manifest the UI reads to report which engines are available.
  const manifest = {
    kernel: 'public/wasm/llmcalc-kernel.wasm',
    wasi: 'public/wasm/llmcalc-wasi.wasm',
    kernelBytes: fs.existsSync(path.join(root, 'public/wasm/llmcalc-kernel.wasm'))
      ? fs.statSync(path.join(root, 'public/wasm/llmcalc-kernel.wasm')).size
      : 0,
    wasiBytes: fs.existsSync(dest) ? fs.statSync(dest).size : 0,
    builtAt: new Date().toISOString(),
    targets: ['wasm32-unknown-unknown', 'wasm32-wasi-preview1'],
  };
  fs.writeFileSync(
    path.join(root, 'public/wasm/manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log('✓ manifest       public/wasm/manifest.json');
}

function main() {
  const kernelOnly = process.argv.includes('--kernel-only');
  console.log(`⚙  AssemblyScript ${ascVersion()} → WebAssembly${kernelOnly ? ' (kernel only)' : ''}\n`);
  let total = 0;
  for (const target of kernelOnly ? targets.slice(0, 1) : targets) total += build(target);
  if (!kernelOnly) postProcess();
  console.log(`\n✓ wasm build complete — ${(total / 1024).toFixed(2)} kB total\n`);
}

function ascVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/assemblyscript/package.json'), 'utf8'));
    return `v${pkg.version}`;
  } catch {
    return '';
  }
}

main();
