#!/usr/bin/env node
/**
 * CI gate for the WebAssembly artifacts.
 *
 *   npm run wasm:verify        # builds if needed, then asserts
 *
 * Checks:
 *   1. both modules exist and are small
 *   2. the browser kernel has zero host imports and exports the full API
 *   3. the WASI module only imports wasi_snapshot_preview1 functions
 *   4. `selftest` inside the WASI runtime returns the golden values
 *   5. `wasm/kernel.ts` (AssemblyScript) and `src/wasm/kernel.ts` (TS) agree
 *      on the exported function set — the parity *values* are covered by
 *      `src/wasm/kernel.test.ts` with fast-check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { KERNEL_MODULE_PATH, WASI_MODULE_PATH, moduleInfo, runWasiJson, wasiAvailable } from './lib/wasi-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = {
  weightsGB_8B_fp16: 16,
  kvGB_L32_4k_fp16: 0.54,
  tps_3350GBs_16GBactive: 177,
  ttftMs_4kctx_989tflops: 133,
  gpusFor20GB_on24GB: 1,
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function ensureBuilt() {
  if (fs.existsSync(KERNEL_MODULE_PATH) && fs.existsSync(WASI_MODULE_PATH)) return;
  console.log('  · artifacts missing — running scripts/build-wasm.mjs\n');
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { cwd: root, stdio: 'inherit' });
}

function tsKernelFunctions() {
  // Parse the TS interface instead of importing it (this script is plain node).
  const source = fs.readFileSync(path.join(root, 'src/wasm/kernel.ts'), 'utf8');
  const block = /export interface KernelApi \{(?<body>[\s\S]*?)\n\}/.exec(source)?.groups?.body ?? '';
  return [...block.matchAll(/^\s{2}(\w+)\(/gm)].map(m => m[1]).sort();
}

console.log('\nLLMcalc wasm verification\n────────────────────────\n');
ensureBuilt();

// 1 ── artifacts
const kernel = moduleInfo(KERNEL_MODULE_PATH);
const wasi = moduleInfo(WASI_MODULE_PATH);
check('kernel module built', kernel.available, `${(kernel.bytes / 1024).toFixed(2)} kB`);
check('wasi module built', wasi.available, `${(wasi.bytes / 1024).toFixed(2)} kB`);
check('kernel under 32 kB', kernel.bytes < 32 * 1024, `${kernel.bytes} bytes`);
check('wasi module under 64 kB', wasi.bytes < 64 * 1024, `${wasi.bytes} bytes`);

// 2 ── kernel surface
check('kernel has no host imports', kernel.imports.length === 0, kernel.imports.join(', '));
const expectedFns = tsKernelFunctions();
const missing = expectedFns.filter(fn => !kernel.exports.includes(fn));
check(`kernel exports all ${expectedFns.length} API functions`, missing.length === 0, missing.join(', '));

// 3 ── wasi imports
const foreignImports = wasi.imports.filter(i => !i.startsWith('wasi_snapshot_preview1.'));
check('wasi imports confined to wasi_snapshot_preview1', foreignImports.length === 0, foreignImports.join(', '));
check('wasi exports _start (command module)', wasi.exports.includes('_start'));

// 4 ── runtime self test
const selftest = await runWasiJson(['selftest']);
check('wasi selftest executes', selftest.ok === true, selftest.error ?? '');
for (const [key, expected] of Object.entries(EXPECTED)) {
  check(`selftest ${key} = ${expected}`, selftest[key] === expected, `got ${selftest[key]}`);
}

// 5 ── manifest
const manifestPath = path.join(root, 'public/wasm/manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
check('manifest emitted', Boolean(manifest), manifestPath.replace(root + '/', ''));

console.log(
  `\n${failures === 0
    ? '✓ wasm verification passed — browser kernel and WASI module are consistent\n'
    : `✗ ${failures} check(s) failed\n`}`,
);
process.exit(failures === 0 ? 0 : 1);
