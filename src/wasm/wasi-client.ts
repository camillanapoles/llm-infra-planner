/**
 * Client for the WASI runtime host (`scripts/wasi-server.mjs`).
 *
 * Browser-friendly rules:
 *   - always relative URLs (`/api/...`) so the dev server / nginx can proxy to
 *     the WASI process — never `localhost` from the browser;
 *   - every call degrades gracefully: on static hosting (GitHub Pages) there is
 *     no backend, so `unavailable` is an expected, handled state.
 *
 * Spec: `.kiro/specs/12-wasi-runtime.md`
 */
import { WASI_BASE_URL } from '@/lib/env';

const base = WASI_BASE_URL.replace(/\/$/, '');

export interface WasiHealth {
  available: boolean;
  service?: string;
  runtime?: string;
  status?: string;
  module?: {
    available: boolean;
    bytes: number;
    path: string;
    imports: string[];
    exports: string[];
  };
  error?: string;
  checkedAt: number;
}

export interface WasiResult {
  ok: boolean;
  engine?: string;
  runtime?: string;
  command?: string;
  [key: string]: unknown;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
    const payload = (await response.json()) as T;
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** Health probe — never throws. */
export async function wasiHealth(): Promise<WasiHealth> {
  try {
    const health = await request<Omit<WasiHealth, 'available'>>('/api/health', undefined, 2500);
    return { ...health, available: true, checkedAt: Date.now() };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    };
  }
}

/** Runs one command inside the WASI module. Returns null when unreachable. */
export async function wasiCompute<T extends WasiResult = WasiResult>(
  command: string,
  params: Record<string, string | number>,
): Promise<T | null> {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  try {
    return await request<T>(`/api/${command}?${query.toString()}`);
  } catch {
    return null;
  }
}

/** Health probe helper with a human-readable verdict for the UI. */
export function describeHealth(health: WasiHealth | null): string {
  if (!health) return 'checking…';
  if (!health.available) return 'unavailable (static hosting)';
  if (!health.module?.available) return 'running · module not built';
  return `running · ${(health.module.bytes / 1024).toFixed(2)} kB module`;
}
