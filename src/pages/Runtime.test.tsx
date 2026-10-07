/**
 * @vitest-environment happy-dom
 *
 * Render test for the Runtime page — it must survive the two states that matter
 * in production: wasm kernel available (static hosting / docker) and WASI host
 * unreachable (GitHub Pages has no backend).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Runtime } from './Runtime';
import { resetKernelCache } from '@/wasm/kernel';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM_PATH = path.join(root, 'public', 'wasm', 'llmcalc-kernel.wasm');

const wasmBytes = () => {
  const buffer = fs.readFileSync(WASM_PATH);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

beforeAll(() => {
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error('run `npm run build:wasm` before the test suite (see scripts/verify-wasm.mjs)');
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetKernelCache();
});

describe('Runtime page', () => {
  it('reports the wasm kernel and an offline WASI host', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('llmcalc-kernel.wasm')) {
        return new Response(wasmBytes(), { status: 200, headers: { 'content-type': 'application/wasm' } });
      }
      throw new Error('ECONNREFUSED'); // no backend on static hosting
    }));

    render(<Runtime />);

    expect(screen.getByText('WebAssembly kernel')).toBeDefined();
    expect(screen.getByText('WASI runtime host')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText('WASM kernel active')).toBeDefined();
    }, { timeout: 3000 });

    // parity matrix rendered with a passing verdict for every case
    await waitFor(() => {
      expect(screen.getByText(/checks identical/)).toBeDefined();
    });
    expect(screen.getAllByLabelText('identical').length).toBeGreaterThan(10);
    expect(screen.getByText(/npm run wasi:serve/)).toBeDefined();
  });

  it('renders the WASI host panel when the runtime responds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('llmcalc-kernel.wasm')) {
        return new Response(wasmBytes(), { status: 200, headers: { 'content-type': 'application/wasm' } });
      }
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({
          ok: true,
          service: 'llmcalc-wasi-runtime',
          runtime: 'node v22 · node:wasi (preview1)',
          status: 'ready',
          module: { available: true, bytes: 5728, path: 'wasi/dist/llmcalc-wasi.wasm', imports: ['wasi_snapshot_preview1.fd_write'], exports: ['_start'] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    render(<Runtime />);

    await waitFor(() => {
      expect(screen.getByText('WASI host online')).toBeDefined();
    }, { timeout: 3000 });
    expect(screen.getByText('Run plan in WASI')).toBeDefined();
  });
});
