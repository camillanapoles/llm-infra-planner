/**
 * React bindings for the wasm kernel + WASI runtime host.
 * Spec: `.kiro/specs/11-wasm-kernel.md`, `.kiro/specs/12-wasi-runtime.md`
 */
import * as React from 'react';
import {
  PARITY_CASES,
  getKernel,
  measure,
  runParity,
  type KernelApi,
  type KernelStatus,
  type ParityResult,
} from './kernel';
import { wasiHealth, type WasiHealth } from './wasi-client';

export interface KernelBenchmark {
  jsMs: number;
  wasmMs: number;
  iterations: number;
  speedup: number;
  jsOpsPerSecond: number;
  wasmOpsPerSecond: number;
}

export interface KernelHookState {
  status: KernelStatus | null;
  parity: ParityResult[] | null;
  benchmark: KernelBenchmark | null;
  loading: boolean;
}

const BENCH_ITERATIONS = 200_000;

/** Loads the kernel once per page and reports status, parity and a benchmark. */
export function useKernel(): KernelHookState {
  const [state, setState] = React.useState<KernelHookState>({
    status: null,
    parity: null,
    benchmark: null,
    loading: true,
  });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const { kernel, status } = await getKernel();
      const parity = runParity(kernel, PARITY_CASES);
      const benchmark = status.wasmLoaded ? benchmarkKernels(kernel) : null;
      if (!cancelled) {
        setState({ status, parity, benchmark, loading: false });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return state;
}

/** JS vs wasm timing on the hottest kernel function (throughput estimate). */
export function benchmarkKernels(wasmKernel: KernelApi, iterations = BENCH_ITERATIONS): KernelBenchmark {
  const js = measure(() => {
    measureJsThroughput(iterations);
  }, 1);
  const wasm = measure(() => {
    for (let i = 0; i < iterations; i++) wasmKernel.throughputTps(3350, 12 + (i % 7), 0.85);
  }, 1);
  return {
    jsMs: js.ms,
    wasmMs: wasm.ms,
    iterations,
    speedup: wasm.ms > 0 ? Math.round((js.ms / wasm.ms) * 10) / 10 : 0,
    jsOpsPerSecond: js.opsPerSecond,
    wasmOpsPerSecond: wasm.opsPerSecond,
  };
}

function measureJsThroughput(iterations: number): void {
  let sink = 0;
  for (let i = 0; i < iterations; i++) {
    const bw = 3350;
    const active = 12 + (i % 7);
    sink += Math.floor((bw / active) * 0.85);
  }
  if (sink === -1) console.log(sink); // keep the JIT honest
}

/** Polls the local WASI runtime host, if one is reachable. */
export function useWasiRuntime(intervalMs = 30_000) {
  const [health, setHealth] = React.useState<WasiHealth | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setHealth(await wasiHealth());
    setLoading(false);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const result = await wasiHealth();
      if (!cancelled) {
        setHealth(result);
        setLoading(false);
      }
    };
    void tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [intervalMs]);

  return { health, loading, refresh };
}
