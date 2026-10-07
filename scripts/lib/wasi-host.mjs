/**
 * Minimal WASI preview1 host built on Node's built-in `node:wasi`.
 *
 * Instantiates `wasi/dist/llmcalc-wasi.wasm` as a WASI *command* module and
 * captures its stdout. No native deps, no wasmtime install required — Node 20+
 * ships a preview1 host.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const WASI_MODULE_PATH = process.env.WASM_MODULE
  ? path.resolve(process.env.WASM_MODULE)
  : path.join(root, 'wasi', 'dist', 'llmcalc-wasi.wasm');

export const KERNEL_MODULE_PATH = path.join(root, 'public', 'wasm', 'llmcalc-kernel.wasm');

/** True when the WASI command module has been built. */
export function wasiAvailable(modulePath = WASI_MODULE_PATH) {
  return fs.existsSync(modulePath);
}

export function moduleInfo(modulePath = WASI_MODULE_PATH) {
  if (!wasiAvailable(modulePath)) {
    return { available: false, path: modulePath, bytes: 0 };
  }
  const bytes = fs.readFileSync(modulePath);
  const mod = new WebAssembly.Module(bytes);
  return {
    available: true,
    path: modulePath,
    bytes: bytes.length,
    imports: WebAssembly.Module.imports(mod).map(i => `${i.module}.${i.name}`),
    exports: WebAssembly.Module.exports(mod).map(e => e.name),
  };
}

/**
 * Runs the WASI module with `args` and returns its stdout.
 *
 * @param {string[]} args              arguments after argv[0]
 * @param {{ modulePath?: string }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string }>}
 */
export async function runWasi(args, options = {}) {
  const modulePath = options.modulePath ?? WASI_MODULE_PATH;
  if (!wasiAvailable(modulePath)) {
    throw new Error(
      `WASI module not found at ${modulePath}. Run \`npm run build:wasm\` first.`,
    );
  }

  const bytes = fs.readFileSync(modulePath);
  const mod = new WebAssembly.Module(bytes);

  // Capture stdout through a temp file descriptor — WASI writes to a real fd.
  const tmp = path.join(os.tmpdir(), `llmcalc-wasi-${process.pid}-${Date.now()}.out`);
  const fd = fs.openSync(tmp, 'w+');

  const wasi = new WASI({
    version: 'preview1',
    args: ['llmcalc-wasi', ...args.map(String)],
    env: {},
    returnOnExit: true,
    stdout: fd,
    stderr: fd,
  });

  let exitCode = 0;
  try {
    const instance = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    exitCode = wasi.start(instance) ?? 0; // wasi.start() runs `_start`
  } finally {
    fs.closeSync(fd);
  }

  const stdout = fs.readFileSync(tmp, 'utf8').trim();
  fs.rmSync(tmp, { force: true });
  return { exitCode, stdout };
}

/** Convenience wrapper that parses the module's JSON output. */
export async function runWasiJson(args, options = {}) {
  const { exitCode, stdout } = await runWasi(args, options);
  try {
    return { ...JSON.parse(stdout), exitCode };
  } catch {
    return { ok: false, exitCode, error: 'invalid JSON from wasm module', raw: stdout };
  }
}
