import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * O smoke test das imagens, no lado do produto.
 *
 * O passo "Smoke test the images" do `docker.yml` afirma saúde assim:
 *
 *     curl -sf http://127.0.0.1:8787/api/selftest | grep -q '"ok":true'
 *
 * O runtime responde JSON **formatado** (`"ok": true`), então esse padrão nunca
 * casava e o passo ficava vermelho com o serviço saudável — a primeira execução
 * real dele no modo registry falhou exatamente assim. Aqui o servidor de verdade
 * sobe e é interrogado com o padrão extraído do próprio workflow, para que a
 * asserção do CI e a saída do runtime não possam divergir de novo em silêncio.
 */

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'docker.yml');
const MODULE = path.join(ROOT, 'wasi', 'dist', 'llmcalc-wasi.wasm');

const workflow = fs.readFileSync(WORKFLOW, 'utf8');

/** O padrão ERE que o CI usa para afirmar `ok: true`. */
const ciPattern = workflow.match(/grep -qE '([^']+)'/)?.[1];
/** A query de `/api/plan` que o CI usa como caso de fumaça. */
const ciPlanQuery = workflow.match(/\/api\/plan\?([^"]+)"/)?.[1];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`o runtime não respondeu /health em ${timeoutMs}ms`);
}

/** Roda o mesmo `grep -qE` do CI sobre um corpo de resposta. */
function grepLikeCi(body: string, pattern: string): boolean {
  try {
    execFileSync('grep', ['-qE', pattern], { input: body });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!fs.existsSync(MODULE))('smoke test do runtime WASI (como o CI faz)', () => {
  let child: ChildProcess;
  let base = '';

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('node', ['scripts/wasi-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, WASI_HOST: '127.0.0.1', WASI_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth(base);
  }, 30000);

  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it('o CI afirma com um padrão que casa com a saída real do runtime', async () => {
    expect(ciPattern).toBeTruthy();
    const body = await (await fetch(`${base}/api/selftest`)).text();

    expect(JSON.parse(body).ok).toBe(true);
    expect(regexMatchedByCi(body)).toBe(true);
  }, 15000);

  it('/api/plan responde ao caso de fumaça do CI', async () => {
    expect(ciPlanQuery).toBeTruthy();
    const body = await (await fetch(`${base}/api/plan?${ciPlanQuery}`)).text();
    const plan = JSON.parse(body) as Record<string, number | boolean | string>;

    expect(plan.ok).toBe(true);
    expect(plan.exitCode).toBe(0);
    expect(plan.weightsGB).toBe(16);
    expect(plan.kvCacheGB).toBe(0.54);
    expect(plan.overheadGB).toBe(0.5);
    expect(plan.tokensPerSecond).toBe(1500);
  }, 15000);

  it('o workflow não volta ao padrão que só casa JSON compacto', () => {
    const body = `{\n  "ok": true\n}`;
    expect(grepLikeCi(body, '"ok":true')).toBe(false); // o padrão frágil, para contraste

    // Comentários podem citar o padrão antigo (o do docker.yml cita); comandos, não.
    const commands = workflow
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain(`'"ok":true'`);
    expect(commands.match(/grep -qE '([^']+)'/g)).toHaveLength(2);
    expect(regexMatchedByCi(body)).toBe(true);
  });

  function regexMatchedByCi(body: string): boolean {
    return ciPattern ? grepLikeCi(body, ciPattern) : false;
  }
});
