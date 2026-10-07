#!/usr/bin/env node
/**
 * Builds the GitHub Pages artifact for one or all environments.
 *
 * Layout produced (matches the live site):
 *
 *   _site/
 *   ├── index.html                 ← production  (/llm-infra-planner/)
 *   ├── 404.html                   ← SPA deep-link fallback (production)
 *   ├── assets/…, wasm/…
 *   ├── staging/                   ← staging     (/llm-infra-planner/staging/)
 *   │   ├── index.html, 404.html, assets/…
 *   └── dev/                       ← dev         (/llm-infra-planner/dev/)
 *       ├── index.html, 404.html, assets/…
 *
 * Because GitHub Pages serves a single site per repository, all three
 * environments live under sub-paths and each deploys in its own CI job
 * (see `.github/workflows/deploy-pages.yml` and spec 13-deploy-github-pages.md).
 *
 * Usage:
 *   node scripts/build-pages-artifact.mjs --env production
 *   node scripts/build-pages-artifact.mjs --env all --out _site
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const envArg = args[args.indexOf('--env') + 1] ?? 'production';
const outDir = path.resolve(root, args[args.indexOf('--out') + 1] ?? '_site');
const repoBase = process.env.PAGES_BASE ?? '/llm-infra-planner/';

const ENVS = {
  production: { base: repoBase, appEnv: 'production', dir: '' },
  staging: { base: `${repoBase}staging/`, appEnv: 'staging', dir: 'staging' },
  dev: { base: `${repoBase}dev/`, appEnv: 'dev', dir: 'dev' },
};

const targets = envArg === 'all' ? Object.keys(ENVS) : [envArg];
for (const target of targets) {
  if (!ENVS[target]) {
    console.error(`✖ unknown environment "${target}" — expected: ${Object.keys(ENVS).join(' | ')} | all`);
    process.exit(1);
  }
}

function buildOne(name) {
  const { base, appEnv, dir } = ENVS[name];
  const destination = path.join(outDir, dir);
  console.log(`\n▶ ${name.padEnd(10)} base=${base} → ${path.relative(root, destination) || '.'}`);

  const env = {
    ...process.env,
    VITE_APP_ENV: appEnv,
    VITE_BASE_PATH: base,
    VITE_APP_VERSION: process.env.VITE_APP_VERSION ?? readVersion(),
    VITE_COMMIT: process.env.VITE_COMMIT ?? gitHead(),
    VITE_BUILT_AT: new Date().toISOString(),
  };

  execFileSync('npx', ['vite', 'build', '--outDir', destination, '--emptyOutDir'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });

  // SPA fallback for GitHub Pages (no server-side rewrites) + no Jekyll processing
  fs.copyFileSync(path.join(destination, 'index.html'), path.join(destination, '404.html'));
  fs.writeFileSync(path.join(destination, '.nojekyll'), '');
  const bytes = directorySize(destination);
  console.log(`  ✓ ${name} built — ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

fs.mkdirSync(outDir, { recursive: true });
for (const target of targets) buildOne(target);

// A landing helper so /llm-infra-planner/ cannot be confused with the envs
if (targets.length > 1) {
  console.log(`\n✓ Pages artifact ready in ${path.relative(root, outDir)} (${targets.join(', ')})\n`);
}
