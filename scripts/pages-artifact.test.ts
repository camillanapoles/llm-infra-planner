import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * O contrato do artefato de Pages, executado como o CI executa.
 *
 * Existe porque a violação desse contrato já derrubou um deploy de verdade: num
 * repositório recém-mesclado, as branches `dev`/`staging` ainda não existiam, o
 * workflow publicava placeholders sem `assets/` e sem kernel, e o `assemble`
 * recusava o artefato — produção incluída. Aqui o contrato fica pinado.
 */

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-pages-artifact.sh');
const BASE = '/llm-infra-planner/';

interface Files {
  [relative: string]: string;
}

function artifact(files: Files): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-artifact-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function verify(dir: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, dir], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const realPage = (envBase: string): string =>
  `<!doctype html><html><head><script type="module" src="${envBase}assets/index-abc.js"></script></head><body>app</body></html>`;

const placeholderPage = (env: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="llmcalc-placeholder" content="${env}"><title>not deployed</title>`;

const kernel = 'WASM-BINARY';

/** Artefato completo, com os três ambientes de verdade. */
const completeArtifact = (): Files => ({
  'index.html': realPage(BASE),
  '404.html': 'not found',
  'wasm/llmcalc-kernel.wasm': kernel,
  'dev/index.html': realPage(`${BASE}dev/`),
  'dev/wasm/llmcalc-kernel.wasm': kernel,
  'staging/index.html': realPage(`${BASE}staging/`),
  'staging/wasm/llmcalc-kernel.wasm': kernel,
});

describe('pages artifact contract', () => {
  it('accepts a complete artifact (three environments, each with its kernel)', () => {
    const result = verify(artifact(completeArtifact()));
    expect(result.ok).toBe(true);
    expect(result.output).toContain('three environments');
  });

  it('accepts a DECLARED placeholder for a branch that does not exist yet, kernel included', () => {
    const files = completeArtifact();
    // dev e staging viram placeholders (branches ainda não criadas), com kernel próprio
    files['dev/index.html'] = placeholderPage('dev');
    files['staging/index.html'] = placeholderPage('staging');
    const result = verify(artifact(files));
    expect(result.ok).toBe(true);
    expect(result.output).toContain('declared placeholder');
  });

  it('rejects a placeholder that forgot the kernel — the SPA would fetch a 404', () => {
    const files = completeArtifact();
    files['dev/index.html'] = placeholderPage('dev');
    delete files['dev/wasm/llmcalc-kernel.wasm'];
    const result = verify(artifact(files));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('dev/ has no wasm kernel');
  });

  it('rejects a real page built with the wrong base path (deep links would break)', () => {
    const files = completeArtifact();
    files['dev/index.html'] = realPage(BASE); // falta o segmento dev/
    const result = verify(artifact(files));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('base path mismatch in dev/');
  });

  it('rejects an artifact without a 404 (SPA deep links would 404 on Pages)', () => {
    const files = completeArtifact();
    delete files['404.html'];
    const result = verify(artifact(files));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('404.html missing');
  });

  it('rejects an artifact missing an environment entirely', () => {
    const files = completeArtifact();
    delete files['staging/index.html'];
    delete files['staging/wasm/llmcalc-kernel.wasm'];
    const result = verify(artifact(files));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('missing');
  });
});
