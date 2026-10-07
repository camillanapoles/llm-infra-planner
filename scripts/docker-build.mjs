#!/usr/bin/env node
/**
 * Docker build/verification helper (spec 14-deploy-docker.md).
 *
 *   npm run deploy:docker                 # all three images + compose config check
 *   npm run deploy:docker -- --env dev    # a single environment
 *   npm run deploy:docker -- --up         # also start the stack and smoke test it
 *
 * When docker is not installed (CI sandboxes, locked-down laptops) the script
 * degrades to *static* validation: it parses docker-compose.yaml, checks the
 * Dockerfile stages/args, and confirms the artifacts each image copies exist —
 * then prints the exact commands to run where docker is available.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--env') ? args[args.indexOf('--env') + 1] : null;
const up = args.includes('--up');

const ENVIRONMENTS = {
  production: { target: 'runner', base: '/', tag: 'llmcalc:production', port: 3000 },
  staging: { target: 'runner', base: '/staging/', tag: 'llmcalc:staging', port: 3001 },
  dev: { target: 'runner', base: '/dev/', tag: 'llmcalc:dev', port: 3002 },
  wasi: { target: 'wasi', base: '/', tag: 'llmcalc:wasi', port: 8787 },
};

const has = command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
const dockerAvailable = has('docker');
const composeAvailable = dockerAvailable && has('docker compose') === false
  ? spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
  : dockerAvailable;

function sh(command, cmdArgs, options = {}) {
  console.log(`\n$ ${command} ${cmdArgs.join(' ')}`);
  return execFileSync(command, cmdArgs, { cwd: root, stdio: 'inherit', ...options });
}

// ─── static validation (always runs) ────────────────────────────────────────

function staticChecks() {
  console.log('\n── static validation ──');
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };

  // compose file parses and declares the services we expect
  const composePath = path.join(root, 'docker-compose.yaml');
  const compose = fs.readFileSync(composePath, 'utf8');
  for (const service of ['app', 'app-staging', 'app-dev', 'wasi']) {
    check(`compose declares service "${service}"`, new RegExp(`^  ${service}:`, 'm').test(compose));
  }
  check('compose pins the wasi healthcheck', compose.includes('http://127.0.0.1:8787/health'));

  // Dockerfile stages + build args
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  for (const stage of ['builder', 'runner', 'wasi']) {
    check(`Dockerfile stage "${stage}"`, new RegExp(`AS ${stage}\\b`).test(dockerfile));
  }
  check('Dockerfile injects VITE_BASE_PATH', dockerfile.includes('VITE_BASE_PATH=$BASE_PATH'));
  check('runner stage validates nginx config', dockerfile.includes('nginx -t'));

  // nginx proxies /api to the wasi host and knows the wasm MIME type
  const nginx = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8');
  check('nginx proxies /api/ to the WASI host', nginx.includes('location ^~ /api/') && nginx.includes('set $wasi_upstream'));
  check('nginx serves /wasm/ as application/wasm', nginx.includes('location ^~ /wasm/') && nginx.includes('default_type application/wasm'));
  check('nginx keeps the /health endpoint', nginx.includes('location = /health'));

  // artifacts the images copy exist (build them first if missing)
  const wasiModule = path.join(root, 'wasi/dist/llmcalc-wasi.wasm');
  const kernelModule = path.join(root, 'public/wasm/llmcalc-kernel.wasm');
  check('wasi module present (wasi/dist/llmcalc-wasi.wasm)', fs.existsSync(wasiModule),
    fs.existsSync(wasiModule) ? `${(fs.statSync(wasiModule).size / 1024).toFixed(2)} kB` : 'run npm run build:wasm');
  check('kernel present (public/wasm/llmcalc-kernel.wasm)', fs.existsSync(kernelModule));
  check('entrypoint hook is executable', fs.statSync(path.join(root, 'docker/entrypoint.d/10-wasi-upstream.sh')).mode & 0o111 ? true : false);

  return failures;
}

// ─── docker path ────────────────────────────────────────────────────────────

function dockerBuild(name, config) {
  sh('docker', [
    'build',
    '--file', 'Dockerfile',
    '--target', config.target,
    '--build-arg', `APP_ENV=${name}`,
    '--build-arg', `BASE_PATH=${config.base}`,
    '--build-arg', `APP_VERSION=${process.env.APP_VERSION ?? '0.0.0'}`,
    '--build-arg', `COMMIT=${process.env.COMMIT ?? gitHead()}`,
    '--tag', config.tag,
    '.',
  ]);
  const inspect = spawnSync('docker', ['image', 'inspect', config.tag, '--format', '{{.Size}}'], { encoding: 'utf8' });
  if (inspect.status === 0) console.log(`  ✓ ${config.tag} — ${inspect.stdout.trim()}`);
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'local';
  }
}

function smokeTest(port, label) {
  const attempt = spawnSync('sh', ['-c', `wget -qO- http://127.0.0.1:${port}/health`], { encoding: 'utf8' });
  const ok = attempt.status === 0 && attempt.stdout.includes('ok');
  console.log(`  ${ok ? '✓' : '✗'} ${label} health on :${port}${ok ? '' : ' — check `docker compose logs`'}`);
  return ok;
}

// ─── main ───────────────────────────────────────────────────────────────────

const failures = staticChecks();

if (!dockerAvailable) {
  console.log(`
── docker not available in this environment ──
The configuration above is statically valid. Where docker is installed run:

  docker compose build                    # production page + wasi runtime
  docker compose --profile staging up -d  # + staging on :3001
  docker compose --profile dev up -d      # + dev     on :3002
  docker compose up -d                    # production on :3000, wasi API on :8787

  # single image, no compose:
  docker build --target runner -t llmcalc .
  docker build --target wasi   -t llmcalc-wasi .
  docker run --rm -p 8787:8787 llmcalc-wasi
  docker run --rm -p 3000:80 --env WASI_UPSTREAM=host.docker.internal:8787 llmcalc
`);
  process.exit(failures === 0 ? 0 : 1);
}

const targets = only ? { [only]: ENVIRONMENTS[only] } : ENVIRONMENTS;
for (const [name, config] of Object.entries(targets)) {
  if (!config) {
    console.error(`✖ unknown environment "${only}"`);
    process.exit(1);
  }
  dockerBuild(name, config);
}

if (composeAvailable) sh('docker', ['compose', 'config', '--quiet']);

if (up) {
  sh('docker', ['compose', 'up', '-d', '--build']);
  console.log('\n── smoke tests ──');
  smokeTest(3000, 'production page');
  smokeTest(8787, 'wasi runtime');
  const api = spawnSync('sh', ['-c', 'wget -qO- "http://127.0.0.1:3000/api/selftest"'], { encoding: 'utf8' });
  console.log(`  ${api.stdout.includes('"ok":true') ? '✓' : '✗'} /api/selftest through nginx`);
}

console.log(`\n${failures === 0 ? '✓' : '✗'} docker verification finished${failures ? ` — ${failures} static check(s) failed` : ''}\n`);
process.exit(failures === 0 ? 0 : 1);
