/**
 * LLMcalc WASI command module (wasm32-wasi preview1)
 * ───────────────────────────────────────────────────
 * A self-contained WASI *command* that computes an inference/training plan from
 * command-line arguments and prints the result as JSON on stdout. It links the
 * same kernel used by the browser (`wasm/kernel.ts`), so a plan computed inside
 * a WASI runtime is identical to the one computed in the page.
 *
 * Why no strings / no runtime?
 *   AssemblyScript string handling pulls in the allocator and the GC. This
 *   module instead works on raw bytes over static data blocks and talks to the
 *   host only through `wasi_snapshot_preview1`. Result: ~1 KB of wasm, exactly
 *   one host import (`fd_write`), deterministic output, and it runs on any
 *   preview1 host (node:wasi, wasmtime, wasmer, wasmedge, wasm3, ...).
 *
 * Usage:
 *   llmcalc-wasi plan <weightsGB> <kvGB> <overheadGB> <tps> <hourlyUsd>
 *   llmcalc-wasi kv <layers> <batch> <seq> <kvHeads> <headDim> <bytes> <attn> [mlaDim]
 *   llmcalc-wasi roofline <bwGBs> <activeWeightsGB> <efficiency>
 *   llmcalc-wasi gpus <requiredGB> <vramPerGpuGB> <usableFraction>
 *   llmcalc-wasi latency <ttftMs> <tpotMs> <outputTokens>
 *   llmcalc-wasi selftest
 *   llmcalc-wasi info
 *
 * Spec: `.kiro/specs/12-wasi-runtime.md`
 */

import {
  weightsGB,
  kvCacheGB,
  kvBytesPerToken,
  throughputTps,
  tpotMs,
  ttftMs,
  costPerMillionTokens,
  totalVramInference,
  gpuCountFor,
  concurrentSequences,
  requestLatencyMs,
} from './kernel';

// ─── WASI preview1 host imports ──────────────────────────────────────────────

@external("wasi_snapshot_preview1", "args_sizes_get")
declare function args_sizes_get(argc: usize, argvBufSize: usize): i32;
@external("wasi_snapshot_preview1", "args_get")
declare function args_get(argv: usize, argvBuf: usize): i32;
@external("wasi_snapshot_preview1", "fd_write")
declare function fd_write(fd: i32, iovs: usize, iovsLen: i32, nwritten: usize): i32;
@external("wasi_snapshot_preview1", "proc_exit")
declare function proc_exit(code: i32): void;

// ─── Static data blocks (no allocator, no GC) ────────────────────────────────

const OUT_SIZE: i32 = 2048;
const ARGS_SIZE: i32 = 2048;
const SCRATCH_SIZE: i32 = 128;
const MAX_ARGS: i32 = 32;
const STDOUT: i32 = 1;
const LF: u8 = 10;
const QUOTE: u8 = 34;
const COLON: u8 = 58;
const COMMA: u8 = 44;
const MINUS: u8 = 45;
const ZERO: u8 = 48;

let out: usize = 0;       // output buffer
let outLen: i32 = 0;
let scratch: usize = 0;   // iovec / digit scratch space
let argsBuf: usize = 0;   // raw argv bytes written by args_get
let argsVec: usize = 0;   // argv pointer table written by args_get
let argCount: i32 = 0;

// ─── Output ──────────────────────────────────────────────────────────────────

function flush(): void {
  if (outLen == 0) return;
  const iov = scratch;
  store<usize>(iov, out);
  store<usize>(iov + sizeof<usize>(), outLen);
  let nwritten: usize = 0;
  fd_write(STDOUT, iov, 1, changetype<usize>(nwritten));
  outLen = 0;
}

function put(c: u8): void {
  if (outLen >= OUT_SIZE) flush();
  store<u8>(out + outLen, c);
  outLen++;
}

function putStr(text: string): void {
  for (let i = 0; i < text.length; i++) put(<u8>(text.charCodeAt(i) & 0x7f));
}

function putNumber(value: u64): void {
  if (value == 0) { put(ZERO); return; }
  let i = 0;
  let v = value;
  while (v > 0) {
    store<u8>(scratch + 32 + i, <u8>(ZERO + (v % 10)));
    v /= 10;
    i++;
  }
  while (i > 0) {
    i--;
    put(load<u8>(scratch + 32 + i));
  }
}

/** Fixed-format f64 (no locale, no scientific notation for our value ranges). */
function putF64(value: f64, places: i32): void {
  if (isNaN(value) || !isFinite(value)) { putStr("null"); return; }
  let v = value;
  if (v < 0) { put(MINUS); v = -v; }

  if (places <= 0) {
    putNumber(<u64>Math.round(v));
    return;
  }
  const factor = <u64>Math.round(Math.pow(10, <f64>places));
  const scaled = <u64>Math.round(v * <f64>factor);
  putNumber(scaled / factor);
  put(46); // '.'
  // always emit exactly `places` fraction digits: 16 → "16.0", 0.5 → "0.50"
  const frac = scaled % factor;
  let divisor = factor / 10;
  while (divisor > 1 && frac < divisor) {
    put(ZERO);
    divisor /= 10;
  }
  putNumber(frac);
}

function putKey(key: string): void {
  put(QUOTE); putStr(key); put(QUOTE); put(COLON);
}

function putField(key: string, value: f64, places: i32): void {
  putKey(key);
  putF64(value, places);
  put(COMMA);
}

function putIntField(key: string, value: i32): void {
  putKey(key);
  if (value < 0) { put(MINUS); putNumber(<u64>(-value)); } else putNumber(<u64>value);
  put(COMMA);
}

function putStrField(key: string, value: string): void {
  putKey(key);
  put(QUOTE); putStr(value); put(QUOTE); put(COMMA);
}

function openJson(command: string): void {
  putStr("{\"ok\":true,\"engine\":\"wasm-wasi\",\"runtime\":\"wasi-preview1\",");
  putStrField("command", command);
}

function closeJson(): void {
  // trim the trailing comma
  if (outLen > 0) outLen--;
  put(125); // '}'
  put(LF);
  flush();
}

// ─── Arguments ───────────────────────────────────────────────────────────────

/** args_get() fills the argv table with absolute linear-memory pointers. */
function argPtr(i: i32): usize {
  return load<usize>(argsVec + <usize>i * sizeof<usize>());
}

function argF64(i: i32, fallback: f64): f64 {
  if (i >= argCount) return fallback;
  let p = argPtr(i);
  let negative = false;
  if (load<u8>(p) == MINUS) { negative = true; p++; }
  let value: f64 = 0;
  let seen = false;
  while (true) {
    const c = load<u8>(p);
    if (c >= ZERO && c <= 57) {
      value = value * 10 + <f64>(c - ZERO);
      seen = true;
      p++;
    } else if (c == 46) {
      p++;
      let scale: f64 = 0.1;
      while (true) {
        const d = load<u8>(p);
        if (d < ZERO || d > 57) break;
        value += <f64>(d - ZERO) * scale;
        scale *= 0.1;
        p++;
      }
      break;
    } else if (c == 101 || c == 69) { // e / E
      p++;
      let expNegative = false;
      if (load<u8>(p) == MINUS) { expNegative = true; p++; }
      else if (load<u8>(p) == 43) p++;
      let exponent: f64 = 0;
      while (true) {
        const d = load<u8>(p);
        if (d < ZERO || d > 57) break;
        exponent = exponent * 10 + <f64>(d - ZERO);
        p++;
      }
      value *= Math.pow(10, expNegative ? -exponent : exponent);
      break;
    } else break;
  }
  if (!seen) return fallback;
  return negative ? -value : value;
}

function argInt(i: i32, fallback: i32): i32 {
  return <i32>argF64(i, <f64>fallback);
}

function argIs(i: i32, expected: string): bool {
  if (i >= argCount) return false;
  let p = argPtr(i);
  for (let k = 0; k < expected.length; k++) {
    const c = load<u8>(p + <usize>k);
    if (c == 0) return false;
    if (c != <u8>(expected.charCodeAt(k) & 0x7f)) return false;
  }
  return load<u8>(p + <usize>expected.length) == 0;
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdPlan(): void {
  const wGB = argF64(2, 0);
  const kvGB = argF64(3, 0);
  const overheadGB = argF64(4, 0);
  const tps = argF64(5, 0);
  const hourlyUsd = argF64(6, 0);
  openJson("plan");
  putField("weightsGB", wGB, 1);
  putField("kvCacheGB", kvGB, 2);
  putField("overheadGB", overheadGB, 2);
  putField("totalVramGB", totalVramInference(wGB, kvGB, overheadGB), 2);
  putField("tokensPerSecond", tps, 0);
  putField("costPerMillionTokens", costPerMillionTokens(tps, hourlyUsd), 2);
  closeJson();
}

function cmdKv(): void {
  const layers = argF64(2, 0);
  const batch = argF64(3, 1);
  const seq = argF64(4, 0);
  const kvHeads = argF64(5, 0);
  const headDim = argF64(6, 0);
  const bytesPerParam = argF64(7, 2);
  const attn = argInt(8, 0);
  const mlaDim = argF64(9, 0);
  openJson("kv");
  putField("kvCacheGB", kvCacheGB(layers, batch, seq, kvHeads, headDim, bytesPerParam, attn, mlaDim), 2);
  putField("bytesPerToken", kvBytesPerToken(layers, kvHeads, headDim, bytesPerParam, attn, mlaDim), 0);
  putIntField("concurrentSequencesAt40GB", concurrentSequences(40, kvBytesPerToken(layers, kvHeads, headDim, bytesPerParam, attn, mlaDim) * seq * 1e-9));
  closeJson();
}

function cmdRoofline(): void {
  const bw = argF64(2, 0);
  const activeWeights = argF64(3, 0);
  const eff = argF64(4, 0.85);
  openJson("roofline");
  putField("tokensPerSecond", throughputTps(bw, activeWeights, eff), 0);
  putField("tpotMs", tpotMs(bw, activeWeights, eff), 3);
  closeJson();
}

function cmdGpus(): void {
  const required = argF64(2, 0);
  const vramPerGpu = argF64(3, 0);
  const usable = argF64(4, 0.9);
  openJson("gpus");
  putField("usablePerGpuGB", vramPerGpu * usable, 2);
  putIntField("gpuCount", gpuCountFor(required, vramPerGpu, usable));
  closeJson();
}

function cmdLatency(): void {
  const ttft = argF64(2, 0);
  const tpot = argF64(3, 0);
  const outputTokens = argF64(4, 0);
  openJson("latency");
  putField("ttftMs", ttft, 2);
  putField("tpotMs", tpot, 3);
  putField("totalLatencyMs", requestLatencyMs(ttft, tpot, outputTokens), 2);
  closeJson();
}

function cmdSelfTest(): void {
  openJson("selftest");
  putField("weightsGB_8B_fp16", weightsGB(8000000000, 2), 1);
  putField("kvGB_L32_4k_fp16", kvCacheGB(32, 1, 4096, 8, 128, 2, 0, 0), 2);
  putField("tps_3350GBs_16GBactive", throughputTps(3350, 16, 0.85), 0);
  putField("ttftMs_4kctx_989tflops", ttftMs(4096, 16, 989), 0);
  putIntField("gpusFor20GB_on24GB", gpuCountFor(20, 24, 0.9));
  putField("expectWeightsGB", 16, 1);
  putField("expectKvGB", 0.54, 2);
  putField("expectTps", 177, 0);
  closeJson();
}

function cmdInfo(): void {
  openJson("info");
  putStrField("module", "llmcalc-wasi");
  putStrField("kernel", "wasm/kernel.ts");
  putStrField("target", "wasm32-wasi-preview1");
  closeJson();
}

function cmdUnknown(): void {
  putStr("{\"ok\":false,\"engine\":\"wasm-wasi\",\"error\":\"unknown command\"}");
  put(LF);
  flush();
  proc_exit(64);
}

// ─── Entry point (WASI command) ──────────────────────────────────────────────

export function _start(): void {
  out = memory.data(OUT_SIZE);
  scratch = memory.data(SCRATCH_SIZE);
  outLen = 0;

  // argv: pointer table + NUL-separated byte buffer, filled in by the host
  argsBuf = memory.data(ARGS_SIZE);
  argsVec = memory.data(MAX_ARGS * sizeof<usize>());

  const sizes = scratch + 16; // scratch[0..16) is the iovec, [16..32) the sizes
  if (args_sizes_get(sizes, sizes + sizeof<usize>()) != 0) { cmdUnknown(); return; }
  const rawArgc = load<i32>(sizes);
  argCount = rawArgc > MAX_ARGS ? MAX_ARGS : rawArgc;
  if (args_get(argsVec, argsBuf) != 0) { cmdUnknown(); return; }
  if (argCount < 2) { cmdInfo(); return; }

  if (argIs(1, "plan")) cmdPlan();
  else if (argIs(1, "kv")) cmdKv();
  else if (argIs(1, "roofline")) cmdRoofline();
  else if (argIs(1, "gpus")) cmdGpus();
  else if (argIs(1, "latency")) cmdLatency();
  else if (argIs(1, "selftest")) cmdSelfTest();
  else if (argIs(1, "info")) cmdInfo();
  else cmdUnknown();
}
