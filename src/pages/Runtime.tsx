import * as React from 'react';
import {
  Cpu, Boxes, Cloud, Server, CheckCircle2, XCircle, Loader2, Play,
  ArrowRight, Gauge, FileCode2, GitBranch, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useKernel, useWasiRuntime } from '@/wasm/use-kernel';
import { wasiCompute, type WasiResult } from '@/wasm/wasi-client';
import {
  APP_ENV, BASE_PATH, BUILD_INFO, ENV, ENV_URLS, ENV_DESCRIPTORS, type AppEnv,
} from '@/lib/env';
import { useCalculatorStore } from '@/store/calculator-store';

// ─── Small building blocks ───────────────────────────────────────────────────

function Card({ icon, title, subtitle, children, action }: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border-subtle bg-bg-subtle/40 p-5 flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 text-fg-muted" aria-hidden="true">{icon}</span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-fg-primary">{title}</h2>
          {subtitle && <p className="text-xs text-fg-muted mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, mono = true, hint }: { label: string; value: React.ReactNode; mono?: boolean; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</span>
      <span className={cn('text-sm text-fg-primary', mono && 'font-mono tabular-nums')}>{value}</span>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'off' | 'info'; children: React.ReactNode }) {
  const tones = {
    ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    off: 'bg-bg-muted text-fg-muted border-border-subtle',
    info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
  } as const;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

// ─── Project state (continuity) ──────────────────────────────────────────────

interface ProjectStateFile {
  generatedAt?: string;
  phase?: string;
  phaseName?: string;
  percent?: number;
  done?: number;
  total?: number;
  next?: { id: string; title: string; blockedBy: string[] }[];
  invariants?: Record<string, number | string | boolean>;
}

/** Reads `public/state.json`, written by `npm run continuity:sync`. */
function useProjectState(): ProjectStateFile | null {
  const [state, setState] = React.useState<ProjectStateFile | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}state.json`)
      .then(response => (response.ok ? response.json() : null))
      .then((data: ProjectStateFile | null) => {
        if (!cancelled && data && typeof data === 'object') setState(data);
      })
      .catch(() => { /* state.json is optional (older builds) */ });
    return () => { cancelled = true; };
  }, []);
  return state;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function Runtime() {
  const { status, parity, benchmark, loading } = useKernel();
  const { health, loading: healthLoading, refresh } = useWasiRuntime();
  const { selectedModel, contextLength, breakdown, costMetrics, engine } = useCalculatorStore();

  const projectState = useProjectState();
  const [wasiRun, setWasiRun] = React.useState<WasiResult | null>(null);
  const [wasiRunning, setWasiRunning] = React.useState(false);
  const [wasiError, setWasiError] = React.useState<string | null>(null);

  const parityFailures = parity?.filter(p => !p.ok) ?? [];

  const runInWasi = React.useCallback(async () => {
    setWasiRunning(true);
    setWasiError(null);
    const weightsGB = breakdown ? Math.round((breakdown.totalGB - (breakdown.kvCacheGB ?? 0)) * 10) / 10 : 16;
    const result = await wasiCompute('plan', {
      weightsGB,
      kvGB: breakdown?.kvCacheGB ?? 0.54,
      overheadGB: 0.5,
      tps: 1500,
      hourlyUsd: 2.49,
    });
    if (result) setWasiRun(result);
    else setWasiError('WASI runtime unreachable — start it with `npm run wasi:serve`');
    setWasiRunning(false);
  }, [breakdown]);

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-semibold text-fg-primary">Runtime</h1>
          <Pill tone={ENV.isDeployed ? 'info' : 'off'}>{ENV.label} build</Pill>
          {status?.engine === 'wasm'
            ? <Pill tone="ok"><Cpu size={11} /> WASM kernel active</Pill>
            : <Pill tone="warn"><FileCode2 size={11} /> JS fallback</Pill>}
          {health?.available
            ? <Pill tone="ok"><Server size={11} /> WASI host online</Pill>
            : <Pill tone="off"><Server size={11} /> WASI host offline</Pill>}
        </div>
        <p className="text-sm text-fg-muted max-w-3xl">
          The calculator runs on a WebAssembly kernel compiled from <code className="font-mono text-xs">wasm/kernel.ts</code>
          {' '}(AssemblyScript → <code className="font-mono text-xs">wasm32</code>), with an identical TypeScript
          reference implementation as fallback. The same kernel is also shipped as a WASI command module that a local
          runtime host executes for API requests.
        </p>
      </div>

      {/* Engines */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          icon={<Cpu size={16} />}
          title="WebAssembly kernel"
          subtitle="Runs in this tab. No dependencies, no host imports, ~2 KB."
        >
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 size={14} className="animate-spin" /> compiling module…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Engine" value={status?.engine.toUpperCase()} />
                <Stat label="Module size" value={status?.bytes ? `${(status.bytes / 1024).toFixed(2)} kB` : '—'} />
                <Stat label="Compile" value={status?.compileMs != null ? `${status.compileMs} ms` : '—'} />
                <Stat label="Instantiate" value={status?.instantiateMs != null ? `${status.instantiateMs} ms` : '—'} />
              </div>

              {status?.error && (
                <p className="text-xs text-amber-600 dark:text-amber-400 font-mono">
                  fallback reason: {status.error} — run <code>npm run build:wasm</code>
                </p>
              )}

              <div className="flex items-center justify-between text-xs">
                <span className="text-fg-muted">
                  Parity vs TypeScript engine:{' '}
                  <span className={cn('font-medium', parityFailures.length === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                    {parity ? `${parity.length - parityFailures.length}/${parity.length} checks identical` : '—'}
                  </span>
                </span>
                {parityFailures.length === 0 && parity
                  ? <CheckCircle2 size={14} className="text-emerald-500" aria-hidden="true" />
                  : <XCircle size={14} className="text-red-500" aria-hidden="true" />}
              </div>

              {benchmark && (
                <div className="rounded-lg border border-border-subtle bg-bg-base p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <Gauge size={13} aria-hidden="true" />
                    Benchmark — throughputTps × {benchmark.iterations.toLocaleString()} calls
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="JavaScript" value={`${benchmark.jsMs} ms`} />
                    <Stat label="WebAssembly" value={`${benchmark.wasmMs} ms`} />
                    <Stat label="Speedup" value={`${benchmark.speedup}×`} />
                  </div>
                </div>
              )}
            </>
          )}
        </Card>

        <Card
          icon={<Server size={16} />}
          title="WASI runtime host"
          subtitle="The same kernel as a preview1 command module, executed server-side."
          action={
            <button
              onClick={() => void refresh()}
              className="w-7 h-7 grid place-items-center rounded-md border border-border-subtle text-fg-muted hover:text-fg-primary hover:bg-bg-muted transition-colors"
              aria-label="Re-check the WASI runtime"
            >
              <RefreshCw size={13} className={cn(healthLoading && 'animate-spin')} aria-hidden="true" />
            </button>
          }
        >
          {health?.available ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Runtime" value={health.runtime ?? 'node:wasi'} mono={false} />
                <Stat label="Status" value={health.status ?? 'ready'} />
                <Stat label="Module" value={health.module?.available ? `${(health.module.bytes / 1024).toFixed(2)} kB` : 'not built'} />
                <Stat label="Imports" value={health.module?.imports.length ?? 0} hint={health.module?.imports.join(', ')} />
              </div>
              <p className="text-xs text-fg-muted font-mono break-all">
                {health.module?.imports.join(' · ')}
              </p>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void runInWasi()}
                  disabled={wasiRunning}
                  className="h-8 px-3 rounded-md text-sm font-medium flex items-center gap-1.5 bg-accent text-white hover:brightness-110 disabled:opacity-60 transition"
                >
                  {wasiRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  Run plan in WASI
                </button>
                <span className="text-xs text-fg-muted">POST /api/plan → wasm module</span>
              </div>

              {wasiError && <p className="text-xs text-red-500">{wasiError}</p>}
              {wasiRun && (
                <pre className="text-xs font-mono bg-bg-base border border-border-subtle rounded-lg p-3 overflow-x-auto">
                  {JSON.stringify(wasiRun, null, 2)}
                </pre>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-3 text-sm text-fg-muted">
              <p>
                No WASI host on this origin{ENV.hasBackend ? '' : ' (static hosting)'}. Start one locally and the page
                will pick it up automatically:
              </p>
              <pre className="text-xs font-mono bg-bg-base border border-border-subtle rounded-lg p-3 overflow-x-auto">
{`npm run build:wasm     # → wasi/dist/llmcalc-wasi.wasm
npm run wasi:serve     # → http://localhost:8787  (/api/* proxied by vite)
npm run wasi -- selftest`}
              </pre>
              <p className="text-xs">
                Any preview1 host works too: <code className="font-mono">wasmtime run wasi/dist/llmcalc-wasi.wasm -- plan 16 0.54 0.5 1500 2.49</code>
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* Parity detail */}
      {parity && (
        <Card icon={<Boxes size={16} />} title="Kernel parity matrix" subtitle="WebAssembly vs TypeScript, computed live in this tab.">
          <div className="overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full text-xs" aria-label="Kernel parity matrix">
              <thead>
                <tr className="bg-bg-subtle border-b border-border-subtle text-[10px] uppercase tracking-wider text-fg-muted">
                  <th className="text-left px-3 py-2 font-medium">Case</th>
                  <th className="text-right px-3 py-2 font-medium">WebAssembly</th>
                  <th className="text-right px-3 py-2 font-medium">TypeScript</th>
                  <th className="text-right px-3 py-2 font-medium">Δ</th>
                  <th className="text-right px-3 py-2 font-medium">Match</th>
                </tr>
              </thead>
              <tbody>
                {parity.map(row => (
                  <tr key={row.name} className="border-b border-border-subtle last:border-0">
                    <td className="px-3 py-2 text-fg-default">{row.name}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-default">{row.wasm.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-muted">{row.js.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-muted">{row.delta}</td>
                    <td className="px-3 py-2 text-right">
                      {row.ok
                        ? <CheckCircle2 size={13} className="inline text-emerald-500" aria-label="identical" />
                        : <XCircle size={13} className="inline text-red-500" aria-label="divergent" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Engine wiring in the calculator */}
      <Card
        icon={<Gauge size={16} />}
        title="Calculator wiring"
        subtitle="Which engine produced the numbers currently on screen."
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Active engine" value={engine.kind.toUpperCase()} />
          <Stat label="Verified" value={engine.ready ? (engine.failures === 0 ? 'yes' : `${engine.failures} failures`) : 'pending'} />
          <Stat label="Model" value={selectedModel?.displayName ?? '—'} mono={false} />
          <Stat label="Context" value={`${contextLength.toLocaleString()} tok`} />
          <Stat label="Total VRAM" value={breakdown ? `${breakdown.totalGB.toFixed(2)} GB` : '—'} />
          <Stat label="KV cache" value={breakdown?.kvCacheGB != null ? `${breakdown.kvCacheGB.toFixed(2)} GB` : '—'} />
          <Stat label="Cost / 1M tok" value={costMetrics ? `$${costMetrics.costPerMillionTokens.toFixed(2)}` : '—'} />
          <Stat label="TTFT" value={costMetrics ? `${costMetrics.timeToFirstTokenMs} ms` : '—'} />
        </div>
        <p className="text-xs text-fg-muted">
          The wasm kernel recomputes cost-per-million-tokens and TTFT on every store update; the TypeScript path stays
          as the fallback and the test oracle (<code className="font-mono">src/wasm/kernel.test.ts</code>).
        </p>
      </Card>

      {/* Continuity: where the project stopped and what comes next */}
      {projectState && (
        <Card
          icon={<GitBranch size={16} />}
          title="Estado do projeto (continuidade)"
          subtitle="Gerado por npm run continuity:sync — o ponto de retomada viaja com o código."
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Fase" value={`${projectState.phase ?? '—'} · ${projectState.phaseName ?? ''}`.trim()} mono={false} />
            <Stat label="Progresso" value={projectState.percent != null ? `${projectState.percent}%` : '—'} />
            <Stat label="Tarefas" value={projectState.done != null ? `${projectState.done}/${projectState.total ?? '?'}` : '—'} />
            <Stat label="Sincronizado" value={projectState.generatedAt ? new Date(projectState.generatedAt).toLocaleString() : '—'} />
          </div>
          {projectState.next && projectState.next.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">Próximas tarefas</span>
              {projectState.next.map(task => (
                <div key={task.id} className="flex items-center gap-2 text-xs">
                  <code className="font-mono text-fg-muted">{task.id}</code>
                  <span className="text-fg-default">{task.title}</span>
                  {task.blockedBy.length > 0 && (
                    <Pill tone="warn">bloqueado: {task.blockedBy.join(', ')}</Pill>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-fg-muted">
            Fluxo completo em <code className="font-mono">CONTINUITY.md</code> · estado legível em{' '}
            <code className="font-mono">.kiro/state/STATE.md</code> · retomada em{' '}
            <code className="font-mono">.kiro/state/RESUME.md</code>
          </p>
        </Card>
      )}

      {/* Deployment targets */}
      <Card
        icon={<Cloud size={16} />}
        title="Deployment targets"
        subtitle="One codebase, four environments — each with its own spec in .kiro/specs."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {(Object.keys(ENV_DESCRIPTORS) as AppEnv[])
            .filter(env => env !== 'local')
            .map(env => {
              const descriptor = ENV_DESCRIPTORS[env];
              const current = APP_ENV === env;
              return (
                <div key={env} className={cn('rounded-lg border p-3 flex flex-col gap-1.5',
                  current ? 'border-accent/50 bg-accent/5' : 'border-border-subtle bg-bg-base')}>
                  <div className="flex items-center gap-2">
                    <GitBranch size={13} className="text-fg-muted" aria-hidden="true" />
                    <span className="text-sm font-medium text-fg-primary capitalize">{descriptor.label}</span>
                    {current && <Pill tone="ok">this build</Pill>}
                  </div>
                  <span className="text-[11px] text-fg-muted font-mono break-all">
                    {env === 'production' ? 'branch main · docker/nginx' : `branch ${env}`}
                  </span>
                  <a href={ENV_URLS[env]} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline flex items-center gap-1">
                    {ENV_URLS[env]} <ArrowRight size={11} aria-hidden="true" />
                  </a>
                </div>
              );
            })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-border-subtle">
          <Stat label="Build env" value={BUILD_INFO.env} />
          <Stat label="Version" value={BUILD_INFO.version} />
          <Stat label="Commit" value={BUILD_INFO.commit.slice(0, 7)} />
          <Stat label="Base path" value={BASE_PATH} />
        </div>
        <p className="text-xs text-fg-muted">
          Built at <span className="font-mono">{new Date(BUILD_INFO.builtAt).toLocaleString()}</span> ·
          specs: <code className="font-mono">.kiro/specs/11-wasm-kernel.md</code>,{' '}
          <code className="font-mono">12-wasi-runtime.md</code>, <code className="font-mono">13-deploy-github-pages.md</code>,{' '}
          <code className="font-mono">14-deploy-docker.md</code>, <code className="font-mono">15-deploy-local.md</code>
        </p>
      </Card>
    </div>
  );
}
