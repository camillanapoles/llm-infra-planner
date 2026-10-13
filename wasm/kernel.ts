/**
 * LLMcalc WASM calculation kernel (AssemblyScript → wasm32)
 * ─────────────────────────────────────────────────────────
 * Pure numeric primitives extracted from the TypeScript calculation engine in
 * `src/lib/formulas/*`. Every function here is a 1:1 mirror of the TS reference
 * implementation and is verified by parity tests in `src/wasm/kernel.test.ts`
 * (Task: "WASM kernel" — spec `.kiro/specs/11-wasm-kernel.md`).
 *
 * Design rules:
 *   - Only f64 / i32 across the boundary (no strings, no allocation, no runtime)
 *   - Compiled with `--runtime stub` → tiny (< 2 KB) deterministic module
 *   - Rounding happens inside the kernel so browser + WASI results agree exactly
 *
 * Attention type encoding (i32):
 *   0 = mha / gqa (standard multi-head math)
 *   1 = mqa       (single KV head, regardless of numKVHeads)
 *   2 = mla       (DeepSeek compressed latent KV cache)
 */

// ─── Weight memory ───────────────────────────────────────────────────────────

/** weights GB, rounded to 1 decimal — mirrors computeWeightMemory() */
export function weightsGB(numParams: f64, bytesPerParam: f64): f64 {
  const rawBytes = numParams * bytesPerParam;
  return roundTo(rawBytes / 1e9, 1);
}

/** raw bytes (unrounded) of the weights tensor */
export function weightsBytes(numParams: f64, bytesPerParam: f64): f64 {
  return numParams * bytesPerParam;
}

// ─── KV cache ────────────────────────────────────────────────────────────────

/**
 * KV cache GB rounded to 2 decimals — mirrors computeKVCache().
 *
 *   standard : 2 × L × batch × seq × kvHeads × headDim × bytes
 *   mqa      : kvHeads forced to 1
 *   mla      : L × batch × seq × mlaCompressedDim × bytes
 */
export function kvCacheGB(
  numLayers: f64,
  batchSize: f64,
  seqLen: f64,
  numKVHeads: f64,
  headDim: f64,
  bytesPerParam: f64,
  attentionType: i32,
  mlaCompressedDim: f64,
): f64 {
  return roundTo(kvCacheBytes(numLayers, batchSize, seqLen, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim) / 1e9, 2);
}

/** raw KV cache bytes — mirrors computeKVCache().rawBytes */
export function kvCacheBytes(
  numLayers: f64,
  batchSize: f64,
  seqLen: f64,
  numKVHeads: f64,
  headDim: f64,
  bytesPerParam: f64,
  attentionType: i32,
  mlaCompressedDim: f64,
): f64 {
  if (attentionType == 2 && mlaCompressedDim > 0) {
    return numLayers * batchSize * seqLen * mlaCompressedDim * bytesPerParam;
  }
  const effectiveKVHeads = attentionType == 1 ? 1 : numKVHeads;
  return 2 * numLayers * batchSize * seqLen * effectiveKVHeads * headDim * bytesPerParam;
}

/** KV cache bytes for a single token of a single sequence (capacity planning) */
export function kvBytesPerToken(
  numLayers: f64,
  numKVHeads: f64,
  headDim: f64,
  bytesPerParam: f64,
  attentionType: i32,
  mlaCompressedDim: f64,
): f64 {
  return kvCacheBytes(numLayers, 1, 1, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim);
}

// ─── Throughput / latency (roofline) ─────────────────────────────────────────

/** tokens/sec, floored — mirrors computeThroughput() */
export function throughputTps(memoryBandwidthGBs: f64, activeWeightsGB: f64, efficiencyFactor: f64): f64 {
  if (activeWeightsGB <= 0) return 0;
  return Math.floor((memoryBandwidthGBs / activeWeightsGB) * efficiencyFactor);
}

/** decode latency per token in ms (inverse of throughput) */
export function tpotMs(memoryBandwidthGBs: f64, activeWeightsGB: f64, efficiencyFactor: f64): f64 {
  const tps = throughputTps(memoryBandwidthGBs, activeWeightsGB, efficiencyFactor);
  if (tps <= 0) return 0;
  return roundTo(1000 / tps, 2);
}

/** time-to-first-token ms, rounded — mirrors computeCostMetrics().timeToFirstTokenMs */
export function ttftMs(contextLength: f64, activeWeightsGB: f64, computeTFLOPS: f64): f64 {
  if (computeTFLOPS <= 0 || activeWeightsGB <= 0) return 0;
  const prefillFLOPs = contextLength * 2 * activeWeightsGB * 1e9;
  const computeFlopsPerSec = computeTFLOPS * 1e12;
  return roundTo((prefillFLOPs / computeFlopsPerSec) * 1000, 0);
}

/** cost per million tokens USD, rounded to 2 — mirrors computeCostMetrics() */
export function costPerMillionTokens(tokensPerSecond: f64, hourlyCostUsd: f64): f64 {
  if (tokensPerSecond <= 0 || hourlyCostUsd <= 0) return 0;
  const tokensPerHour = tokensPerSecond * 3600;
  return roundTo((hourlyCostUsd / tokensPerHour) * 1e6, 2);
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

/** total VRAM for the inference path (weights + KV + overhead), 2 decimals */
export function totalVramInference(weightsGB_: f64, kvGB: f64, overheadGB: f64): f64 {
  return roundTo(weightsGB_ + kvGB + overheadGB, 2);
}

/** total VRAM for training/fine-tune (weights + grads + optimizer + activations) */
export function totalVramTraining(
  weightsGB_: f64,
  gradientGB: f64,
  optimizerGB: f64,
  activationGB: f64,
  overheadGB: f64,
): f64 {
  return roundTo(weightsGB_ + gradientGB + optimizerGB + activationGB + overheadGB, 2);
}

/** Adam/AdamW optimizer state bytes — 14 × numParams (4+4 fp32 moments + 4+2 master) */
export function adamOptimizerBytes(numParams: f64): f64 {
  return 14 * numParams;
}

/** gradient bytes for a given precision */
export function gradientBytes(numParams: f64, bytesPerParam: f64): f64 {
  return numParams * bytesPerParam;
}

/**
 * How many GPUs are needed to hold `requiredGB` of model state.
 * `usableFraction` accounts for reserved/fragmented VRAM (e.g. 0.9).
 */
export function gpuCountFor(requiredGB: f64, vramPerGpuGB: f64, usableFraction: f64): i32 {
  const usable = vramPerGpuGB * usableFraction;
  if (usable <= 0) return 0;
  return <i32>Math.ceil(requiredGB / usable);
}

/**
 * Concurrent sequences that fit in a KV budget.
 * e.g. kvBudgetGB=40, perSequenceGB=0.5 → 80 concurrent sequences
 */
export function concurrentSequences(kvBudgetGB: f64, kvGBPerSequence: f64): i32 {
  if (kvGBPerSequence <= 0) return 0;
  return <i32>Math.floor(kvBudgetGB / kvGBPerSequence);
}

/** end-to-end latency ms for prompt+output tokens at a given TTFT/TPOT */
export function requestLatencyMs(ttft: f64, tpot: f64, outputTokens: f64): f64 {
  return roundTo(ttft + tpot * outputTokens, 2);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Rounds to `places` decimals the same way the TS engine does. */
function roundTo(value: f64, places: i32): f64 {
  const factor = Math.pow(10, <f64>places);
  return Math.round(value * factor) / factor;
}
