/**
 * Parity tests: the WebAssembly kernel must agree with the production
 * TypeScript calculation engine (`src/lib/formulas/*`) on every input, because
 * the UI switches engines transparently.
 *
 * Spec: `.kiro/specs/11-wasm-kernel.md`
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';

import { computeWeightMemory } from '@/lib/formulas/vram';
import { computeKVCache } from '@/lib/formulas/kvcache';
import { computeThroughput } from '@/lib/formulas/throughput';
import { computeCostMetrics } from '@/lib/formulas/cost-metrics';
import {
  PARITY_CASES,
  encodeAttention,
  instantiateKernel,
  jsKernel,
  kernelFromExports,
  runParity,
  type KernelApi,
} from './kernel';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM_PATH = path.join(root, 'public', 'wasm', 'llmcalc-kernel.wasm');

let kernel: KernelApi;
let wasmBytes: number;

beforeAll(() => {
  if (!fs.existsSync(WASM_PATH)) {
    // Self-healing: build the wasm artifact on demand (CI also builds it up front)
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { cwd: root, stdio: 'inherit' });
  }
  const bytes = fs.readFileSync(WASM_PATH);
  const instance = instantiateKernel(bytes);
  kernel = instance.api;
  wasmBytes = instance.bytes;
});

describe('wasm kernel — module shape', () => {
  it('is a small, dependency-free wasm module', () => {
    expect(wasmBytes).toBeGreaterThan(0);
    expect(wasmBytes).toBeLessThan(32 * 1024);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync(WASM_PATH)));
    expect(imports).toEqual([]); // no host imports at all
  });

  it('exports every function of the KernelApi surface', () => {
    const exports = new WebAssembly.Module(fs.readFileSync(WASM_PATH));
    const names = new Set(WebAssembly.Module.exports(exports).map(e => e.name));
    for (const fn of Object.keys(jsKernel)) {
      expect(names.has(fn), `missing export: ${fn}`).toBe(true);
    }
  });

  it('rejects a module that does not implement the API', () => {
    expect(() => kernelFromExports({} as WebAssembly.Exports)).toThrow(/missing export/);
  });
});

describe('wasm kernel — golden vectors', () => {
  it('matches the values documented in the README', () => {
    expect(kernel.weightsGB(8e9, 2)).toBe(16);
    expect(kernel.kvCacheGB(32, 1, 4096, 8, 128, 2, 0, 0)).toBe(0.54);
    expect(kernel.throughputTps(3350, 16, 0.85)).toBe(177);
    expect(kernel.gpuCountFor(20, 24, 0.9)).toBe(1);
    expect(kernel.costPerMillionTokens(1500, 2.49)).toBe(0.46);
    expect(kernel.totalVramInference(16, 0.54, 0.5)).toBe(17.04);
    expect(kernel.adamOptimizerBytes(70e9)).toBe(14 * 70e9);
  });

  it('passes the built-in parity harness', () => {
    const results = runParity(kernel, PARITY_CASES);
    const failed = results.filter(r => !r.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  });
});

describe('wasm kernel — parity with src/lib/formulas', () => {
  it('weightsGB === computeWeightMemory().weightGB', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e6, max: 2e12, noNaN: true }),
        fc.constantFrom(0.5, 0.606, 0.711, 1.0, 1.0625, 2.0, 4.0),
        (numParams, bytesPerParam) => {
          const reference = computeWeightMemory({ numParams, bytesPerParam });
          expect(kernel.weightsGB(numParams, bytesPerParam)).toBe(reference.weightGB);
          expect(kernel.weightsBytes(numParams, bytesPerParam)).toBe(reference.rawBytes);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('kvCacheGB === computeKVCache().kvCacheGB (mha / gqa / mqa / mla)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 128 }),      // layers
        fc.integer({ min: 1, max: 64 }),       // batch
        fc.integer({ min: 128, max: 131072 }), // seq
        fc.integer({ min: 1, max: 128 }),      // kv heads
        fc.constantFrom(64, 80, 96, 128, 256), // head dim
        fc.constantFrom(0.5, 1.0, 2.0, 4.0),   // bytes
        fc.constantFrom('mha', 'gqa', 'mqa', 'mla' as const),
        fc.integer({ min: 448, max: 1024 }),   // mla compressed dim
        (numLayers, batchSize, seqLen, numKVHeads, headDim, bytesPerParam, attentionType, mlaCompressedDim) => {
          const reference = computeKVCache({
            numLayers,
            batchSize,
            seqLen,
            numKVHeads,
            headDim,
            bytesPerParam,
            attentionType,
            mlaCompressedDim,
          });
          const wasm = kernel.kvCacheGB(
            numLayers,
            batchSize,
            seqLen,
            numKVHeads,
            headDim,
            bytesPerParam,
            encodeAttention(attentionType),
            mlaCompressedDim,
          );
          expect(wasm).toBe(reference.kvCacheGB);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('throughputTps === computeThroughput().tokensPerSecond', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 50, max: 10000, noNaN: true }),
        fc.double({ min: 0.5, max: 500, noNaN: true }),
        fc.double({ min: 0.4, max: 0.99, noNaN: true }),
        (memoryBandwidthGBs, activeWeightsGB, efficiencyFactor) => {
          const reference = computeThroughput({ memoryBandwidthGBs, activeWeightsGB, efficiencyFactor });
          expect(kernel.throughputTps(memoryBandwidthGBs, activeWeightsGB, efficiencyFactor)).toBe(
            reference.tokensPerSecond,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('costPerMillionTokens + ttftMs === computeCostMetrics()', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100000 }),                       // tokens/sec
        fc.double({ min: 0.1, max: 200, noNaN: true }),            // $/hour
        fc.integer({ min: 128, max: 131072 }),                     // context
        fc.double({ min: 0.1, max: 500, noNaN: true }),            // active weights GB
        fc.double({ min: 1, max: 2000, noNaN: true }),             // TFLOPS
        (tokensPerSecond, hourlyCloudCost, contextLength, activeWeightsGB, computeTFLOPS) => {
          const reference = computeCostMetrics({
            tokensPerSecond,
            hourlyCloudCost,
            contextLength,
            activeWeightsGB,
            computeTFLOPS,
          });
          expect(kernel.costPerMillionTokens(tokensPerSecond, hourlyCloudCost)).toBe(
            reference.costPerMillionTokens,
          );
          expect(kernel.ttftMs(contextLength, activeWeightsGB, computeTFLOPS)).toBe(
            reference.timeToFirstTokenMs,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('falls back to the reference kernel without any divergence', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (a, b) => {
          expect(jsKernel.totalVramInference(a, b, b)).toBe(kernel.totalVramInference(a, b, b));
          expect(jsKernel.requestLatencyMs(a, b, 10)).toBe(kernel.requestLatencyMs(a, b, 10));
        },
      ),
      { numRuns: 100 },
    );
  });
});
