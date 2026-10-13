/**
 * Browser-side loader for the LLMcalc WebAssembly kernel.
 *
 * Two engines, one API:
 *   - `wasm` — `public/wasm/llmcalc-kernel.wasm`, built from `wasm/kernel.ts`
 *              (AssemblyScript). Used for every headline metric when available.
 *   - `js`   — the pure TypeScript reference implementation in
 *              `src/lib/formulas/*`, used as fallback *and* as the parity oracle.
 *
 * The wasm module is compiled with `--runtime stub` and exposes only numeric
 * functions, so instantiation is dependency-free and synchronous once the bytes
 * are in memory (~2 KB, no streaming compile stall).
 *
 * Spec: `.kiro/specs/11-wasm-kernel.md`
 */

export type AttentionType = 'mha' | 'gqa' | 'mqa' | 'mla';

/** 0 = mha/gqa, 1 = mqa, 2 = mla — the encoding used inside the wasm kernel. */
export function encodeAttention(attentionType: AttentionType): number {
  switch (attentionType) {
    case 'mqa': return 1;
    case 'mla': return 2;
    default: return 0;
  }
}

export interface KernelApi {
  weightsGB(numParams: number, bytesPerParam: number): number;
  weightsBytes(numParams: number, bytesPerParam: number): number;
  kvCacheGB(numLayers: number, batchSize: number, seqLen: number, numKVHeads: number, headDim: number, bytesPerParam: number, attentionType: number, mlaCompressedDim: number): number;
  kvCacheBytes(numLayers: number, batchSize: number, seqLen: number, numKVHeads: number, headDim: number, bytesPerParam: number, attentionType: number, mlaCompressedDim: number): number;
  kvBytesPerToken(numLayers: number, numKVHeads: number, headDim: number, bytesPerParam: number, attentionType: number, mlaCompressedDim: number): number;
  throughputTps(memoryBandwidthGBs: number, activeWeightsGB: number, efficiencyFactor: number): number;
  tpotMs(memoryBandwidthGBs: number, activeWeightsGB: number, efficiencyFactor: number): number;
  ttftMs(contextLength: number, activeWeightsGB: number, computeTFLOPS: number): number;
  costPerMillionTokens(tokensPerSecond: number, hourlyCostUsd: number): number;
  totalVramInference(weightsGB: number, kvGB: number, overheadGB: number): number;
  totalVramTraining(weightsGB: number, gradientGB: number, optimizerGB: number, activationGB: number, overheadGB: number): number;
  adamOptimizerBytes(numParams: number): number;
  gradientBytes(numParams: number, bytesPerParam: number): number;
  gpuCountFor(requiredGB: number, vramPerGpuGB: number, usableFraction: number): number;
  concurrentSequences(kvBudgetGB: number, kvGBPerSequence: number): number;
  requestLatencyMs(ttft: number, tpot: number, outputTokens: number): number;
}

const roundTo = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * TypeScript reference kernel — byte-for-byte the same math as `wasm/kernel.ts`
 * (the parity test asserts this over randomized inputs).
 */
export const jsKernel: KernelApi = {
  weightsGB: (numParams, bytesPerParam) => roundTo((numParams * bytesPerParam) / 1e9, 1),
  weightsBytes: (numParams, bytesPerParam) => numParams * bytesPerParam,

  kvCacheBytes: (numLayers, batchSize, seqLen, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim) => {
    if (attentionType === 2 && mlaCompressedDim > 0) {
      return numLayers * batchSize * seqLen * mlaCompressedDim * bytesPerParam;
    }
    const effectiveKVHeads = attentionType === 1 ? 1 : numKVHeads;
    return 2 * numLayers * batchSize * seqLen * effectiveKVHeads * headDim * bytesPerParam;
  },
  kvCacheGB(numLayers, batchSize, seqLen, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim) {
    return roundTo(this.kvCacheBytes(numLayers, batchSize, seqLen, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim) / 1e9, 2);
  },
  kvBytesPerToken: (numLayers, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim) =>
    jsKernel.kvCacheBytes(numLayers, 1, 1, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim),

  throughputTps: (memoryBandwidthGBs, activeWeightsGB, efficiencyFactor) =>
    activeWeightsGB <= 0 ? 0 : Math.floor((memoryBandwidthGBs / activeWeightsGB) * efficiencyFactor),
  tpotMs(memoryBandwidthGBs, activeWeightsGB, efficiencyFactor) {
    const tps = this.throughputTps(memoryBandwidthGBs, activeWeightsGB, efficiencyFactor);
    return tps <= 0 ? 0 : roundTo(1000 / tps, 2);
  },
  ttftMs: (contextLength, activeWeightsGB, computeTFLOPS) => {
    if (computeTFLOPS <= 0 || activeWeightsGB <= 0) return 0;
    return roundTo(((contextLength * 2 * activeWeightsGB * 1e9) / (computeTFLOPS * 1e12)) * 1000, 0);
  },
  costPerMillionTokens: (tokensPerSecond, hourlyCostUsd) => {
    if (tokensPerSecond <= 0 || hourlyCostUsd <= 0) return 0;
    return roundTo((hourlyCostUsd / (tokensPerSecond * 3600)) * 1e6, 2);
  },

  totalVramInference: (weightsGB, kvGB, overheadGB) => roundTo(weightsGB + kvGB + overheadGB, 2),
  totalVramTraining: (weightsGB, gradientGB, optimizerGB, activationGB, overheadGB) =>
    roundTo(weightsGB + gradientGB + optimizerGB + activationGB + overheadGB, 2),
  adamOptimizerBytes: (numParams) => 14 * numParams,
  gradientBytes: (numParams, bytesPerParam) => numParams * bytesPerParam,

  gpuCountFor: (requiredGB, vramPerGpuGB, usableFraction) => {
    const usable = vramPerGpuGB * usableFraction;
    return usable <= 0 ? 0 : Math.ceil(requiredGB / usable);
  },
  concurrentSequences: (kvBudgetGB, kvGBPerSequence) =>
    kvGBPerSequence <= 0 ? 0 : Math.floor(kvBudgetGB / kvGBPerSequence),
  requestLatencyMs: (ttft, tpot, outputTokens) => roundTo(ttft + tpot * outputTokens, 2),
};

/** Reads the raw wasm exports and wraps them in the KernelApi shape. */
export function kernelFromExports(exports: WebAssembly.Exports): KernelApi {
  const api: Record<string, (...args: number[]) => number> = {};
  for (const name of Object.keys(jsKernel) as (keyof KernelApi)[]) {
    const fn = exports[name];
    if (typeof fn !== 'function') {
      throw new Error(`wasm kernel is missing export "${name}"`);
    }
    api[name] = (...args: number[]) => (fn as (...a: number[]) => number)(...args);
  }
  return api as unknown as KernelApi;
}

export interface InstantiatedKernel {
  api: KernelApi;
  bytes: number;
  compileMs: number;
  instantiateMs: number;
}

/** Sync instantiation — the kernel is tiny and has no imports. */
export function instantiateKernel(bytes: Uint8Array | ArrayBuffer): InstantiatedKernel {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const t0 = performance.now();
  const module = new WebAssembly.Module(buffer);
  const t1 = performance.now();
  const instance = new WebAssembly.Instance(module, {});
  const t2 = performance.now();
  return {
    api: kernelFromExports(instance.exports),
    bytes: buffer.byteLength,
    compileMs: roundTo(t1 - t0, 2),
    instantiateMs: roundTo(t2 - t1, 2),
  };
}

export type EngineKind = 'wasm' | 'js';

export interface KernelStatus {
  engine: EngineKind;
  /** loaded from the network? (false when instantiation failed and we fell back) */
  wasmLoaded: boolean;
  bytes: number;
  compileMs: number;
  instantiateMs: number;
  url: string;
  error?: string;
}

export const KERNEL_URL = `${import.meta.env?.BASE_URL ?? '/'}wasm/llmcalc-kernel.wasm`.replace(/\/{2,}/g, '/');

/**
 * Fetches and instantiates the wasm kernel, falling back to the TypeScript
 * implementation when the module is missing (e.g. `npm run build:wasm` skipped).
 */
export async function loadKernel(url: string = KERNEL_URL): Promise<{ kernel: KernelApi; status: KernelStatus }> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Guard against an HTML 404 page being served with a 200 status.
    if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61) {
      throw new Error('not a wasm module');
    }
    const { api, bytes: size, compileMs, instantiateMs } = instantiateKernel(bytes);
    return {
      kernel: api,
      status: { engine: 'wasm', wasmLoaded: true, bytes: size, compileMs, instantiateMs, url },
    };
  } catch (error) {
    return {
      kernel: jsKernel,
      status: {
        engine: 'js',
        wasmLoaded: false,
        bytes: 0,
        compileMs: 0,
        instantiateMs: 0,
        url,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ─── Parity harness ──────────────────────────────────────────────────────────

export interface ParityCase {
  name: string;
  run: (k: KernelApi) => number;
}

export interface ParityResult {
  name: string;
  wasm: number;
  js: number;
  delta: number;
  ok: boolean;
}

/** Golden vectors + randomized cases shared by the UI badge and the test suite. */
export const PARITY_CASES: ParityCase[] = [
  { name: 'weights 8B fp16', run: k => k.weightsGB(8e9, 2) },
  { name: 'kv 32L·4K·8kv·fp16', run: k => k.kvCacheGB(32, 1, 4096, 8, 128, 2, 0, 0) },
  { name: 'kv MLA 61L·8K', run: k => k.kvCacheGB(61, 1, 8192, 128, 128, 2, 2, 512) },
  { name: 'kv MQA 32L·128K', run: k => k.kvCacheGB(32, 4, 131072, 8, 128, 1, 1, 0) },
  { name: 'tps 3350GB/s·active 16GB', run: k => k.throughputTps(3350, 16, 0.85) },
  { name: 'tpot 3350GB/s·active 16GB', run: k => k.tpotMs(3350, 16, 0.85) },
  { name: 'ttft 8K ctx·989 TFLOPS', run: k => k.ttftMs(8192, 16, 989) },
  { name: 'cost/1M 1500 tps·$2.49/h', run: k => k.costPerMillionTokens(1500, 2.49) },
  { name: 'vram inference 70+40+2', run: k => k.totalVramInference(70, 40, 2) },
  { name: 'vram training 16+16+224+12+2', run: k => k.totalVramTraining(16, 16, 224, 12, 2) },
  { name: 'adam 70B', run: k => k.adamOptimizerBytes(70e9) },
  { name: 'gpus 20GB on 24GB', run: k => k.gpuCountFor(20, 24, 0.9) },
  { name: 'sequences 40GB / 0.54GB', run: k => k.concurrentSequences(40, 0.54) },
  { name: 'latency ttft 120 + 8.5×512', run: k => k.requestLatencyMs(120, 8.5, 512) },
];

export function runParity(kernel: KernelApi, cases: ParityCase[] = PARITY_CASES): ParityResult[] {
  return cases.map(c => {
    const wasm = c.run(kernel);
    const js = c.run(jsKernel);
    const delta = Math.abs(wasm - js);
    return { name: c.name, wasm, js, delta, ok: delta <= Math.max(1e-9, Math.abs(js) * 1e-12) };
  });
}

/** Runs the wasm module through a JS-side loop — used for the benchmark chip. */
export function measure(fn: () => void, iterations = 1): { ms: number; opsPerSecond: number } {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = performance.now() - t0;
  return { ms: roundTo(ms, 3), opsPerSecond: ms > 0 ? Math.round((iterations / ms) * 1000) : 0 };
}

// ─── Memoized loader (one fetch + compile per page load) ─────────────────────

let cachedLoad: Promise<{ kernel: KernelApi; status: KernelStatus }> | null = null;

/** Shared, memoized kernel load used by the store and the Runtime page. */
export function getKernel(url?: string): Promise<{ kernel: KernelApi; status: KernelStatus }> {
  if (!cachedLoad) cachedLoad = loadKernel(url);
  return cachedLoad;
}

/** Test helper: forget the memoized module. */
export function resetKernelCache(): void {
  cachedLoad = null;
}
