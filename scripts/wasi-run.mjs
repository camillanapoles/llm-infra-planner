#!/usr/bin/env node
/**
 * CLI bridge to the WASI module — the local equivalent of deploying the
 * calculation kernel to a WASI runtime host (wasmtime / Spin / wasmedge).
 *
 *   npm run wasi -- plan 16 0.54 0.5 1500 2.49
 *   npm run wasi -- kv 32 1 4096 8 128 2 0
 *   npm run wasi -- roofline 3350 16 0.85
 *   npm run wasi -- selftest
 *   npm run wasi -- info
 */
import { moduleInfo, runWasi, wasiAvailable } from './lib/wasi-host.mjs';

const args = process.argv.slice(2);

if (!wasiAvailable()) {
  console.error('✖ wasi/dist/llmcalc-wasi.wasm not found — run `npm run build:wasm` first.');
  process.exit(1);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  const info = moduleInfo();
  console.log(`
llmcalc-wasi — LLM infrastructure calculator as a WASI command module
${info.path}
${(info.bytes / 1024).toFixed(2)} kB · imports: ${info.imports.join(', ')}
exports: ${info.exports.join(', ')}

commands:
  plan <weightsGB> <kvGB> <overheadGB> <tokensPerSecond> <hourlyUsd>
  kv <layers> <batch> <seq> <kvHeads> <headDim> <bytesPerParam> <attn:0|1|2> [mlaDim]
  roofline <bandwidthGBs> <activeWeightsGB> <efficiency>
  gpus <requiredGB> <vramPerGpuGB> [usableFraction]
  latency <ttftMs> <tpotMs> <outputTokens>
  selftest
  info
`);
  process.exit(0);
}

const { exitCode, stdout } = await runWasi(args);
if (stdout) {
  // pretty-print JSON for humans, pass anything else through untouched
  try {
    console.log(JSON.stringify(JSON.parse(stdout), null, 2));
  } catch {
    console.log(stdout);
  }
}
process.exit(exitCode);
