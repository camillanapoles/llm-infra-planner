#!/usr/bin/env -S npx tsx
/**
 * Validates the access descriptor — the JSON a new session reads to continue.
 *
 *   npm run validate:access          # falha (exit 1) em erro
 *   npm run validate:access -- --json
 *
 * Checks (see `validateAccessDescriptor` in scripts/lib/continuity-core.ts):
 *   1. shape — every required section present, schema/kind correct;
 *   2. **no secrets** — the file is committed and public, so a token, key or
 *      password anywhere in it is a hard error;
 *   3. commands — every `npm run X`, `scripts/*` and workflow it cites exists;
 *   4. consistency — branch/sha against HEAD, next tasks against the roadmap,
 *      environment URLs against the project's site path.
 *
 * Spec: .kiro/specs/17-continuity-gate.md (Requirement 9)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_FILE, loadRoadmap, validateAccessDescriptor, type Finding } from './lib/continuity-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
const color = { red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', reset: '\x1b[0m', dim: '\x1b[2m' };

const git = (args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const file = path.join(root, ACCESS_FILE);
if (!fs.existsSync(file)) {
  process.stderr.write(`✗ ${ACCESS_FILE} não existe — rode \`npm run continuity:sync\` primeiro\n`);
  process.exit(1);
}

const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

const findings: Finding[] = validateAccessDescriptor(descriptor, {
  scripts: Object.keys(pkg.scripts ?? {}),
  exists: relative => fs.existsSync(path.join(root, relative)),
  headSha: git(['rev-parse', 'HEAD']),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  roadmap: loadRoadmap(root),
});

const errors = findings.filter(finding => finding.level === 'error');
const warnings = findings.filter(finding => finding.level === 'warn');
const infos = findings.filter(finding => finding.level === 'info');

if (json) {
  process.stdout.write(`${JSON.stringify({ file: ACCESS_FILE, ok: errors.length === 0, findings }, null, 2)}\n`);
} else {
  const icon = (level: Finding['level']) => (level === 'error' ? `${color.red}✗${color.reset}` : level === 'warn' ? `${color.yellow}!${color.reset}` : `${color.blue}i${color.reset}`);
  process.stdout.write(`\n${'\x1b[1m'}Descriptor de acesso${'\x1b[0m'} ${color.dim}${ACCESS_FILE}${color.reset}\n\n`);
  for (const finding of findings) {
    process.stdout.write(`  ${icon(finding.level)} ${finding.code}: ${finding.message}\n`);
    if (finding.hint) process.stdout.write(`      ${color.dim}↳ ${finding.hint}${color.reset}\n`);
  }
  process.stdout.write(errors.length === 0 ? `\n\x1b[32m✓ descriptor válido\x1b[0m ${color.dim}(${warnings.length} aviso(s), ${infos.length} info)\x1b[0m\n\n` : `\n${color.red}✗ ${errors.length} problema(s) no descriptor\x1b[0m\n\n`);
}

process.exit(errors.length === 0 ? 0 : 1);
