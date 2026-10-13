import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Como o estado do projeto chega na `main`.
 *
 * O passo de publicação do `continuity-sync` já falhou em silêncio: ele criava um
 * branch, tentava abrir um PR com o erro redirecionado para `/dev/null`, e caía num
 * aviso dizendo que o estado estava "no artefato da run" — sem artefato nenhum e com
 * três branches órfãos acumulados. O caminho de publicação é código de produção, então
 * aqui ele roda como roda no runner: repositório de verdade, remote de verdade e um
 * `gh` de mentira que pode recusar.
 */

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'continuity-sync.yml');
const STEP = 'Publish state — direct push, else PR, else run artifact';

/** Extrai o `run: |` de um passo pelo nome, respeitando a indentação do bloco. */
function extractRun(workflow: string, stepName: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`passo não encontrado: ${stepName}`);

  const runIndex = lines.findIndex((line, i) => i > start && /^\s+run: \|$/.test(line));
  if (runIndex < 0) throw new Error(`passo sem run: | — ${stepName}`);

  const indent = lines[runIndex].match(/^\s*/)![0].length;
  const body: string[] = [];
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && line.match(/^\s*/)![0].length <= indent) break;
    body.push(line.startsWith(' '.repeat(indent + 2)) ? line.slice(indent + 2) : line.trim());
  }
  return body.join('\n');
}

interface Sandbox {
  repo: string;
  remote: string;
  script: string;
  output: string;
  ghLog: string;
  env: NodeJS.ProcessEnv;
  run: () => { code: number; stdout: string; stderr: string };
  branchesOnRemote: () => string[];
  mainOnRemote: () => string;
}

/** Um repo com remote bare, um `gh` de mentira no PATH e o passo pronto para rodar. */
function sandbox(options: { ghCreate?: { code: number; message?: string }; rejectsMainPush?: boolean } = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-publish-'));
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  const ghLog = path.join(dir, 'gh.log');
  const output = path.join(dir, 'github-output');
  fs.mkdirSync(bin);
  fs.writeFileSync(output, '');

  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, '.kiro', 'state'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.kiro', 'state', 'STATE.md'), '# estado\n');
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['add', '-A'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', 'origin', 'main'], repo);

  if (options.rejectsMainPush) {
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in\n    refs/heads/main) echo "protected branch hook declined" >&2; exit 1 ;;\n  esac\ndone\nexit 0\n');
    fs.chmodSync(hook, 0o755);
  }

  // `gh` de mentira: registra a chamada e responde conforme o cenário.
  const createCode = options.ghCreate?.code ?? 0;
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(ghLog)}
case "$1 $2" in
  "pr create")
    ${createCode === 0
      ? 'echo "https://github.com/example/pull/42"; exit 0'
      : `echo ${JSON.stringify(options.ghCreate?.message ?? 'erro do gh')} >&2; exit ${createCode}`} ;;
  "pr view") echo "42"; exit 0 ;;
  "pr merge") exit 0 ;;
esac
exit 0
`,
  );
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  const script = path.join(dir, 'publish.sh');
  fs.writeFileSync(script, extractRun(fs.readFileSync(WORKFLOW, 'utf8'), STEP));

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: 'fake-token',
    CHANGED: 'true',
    GITHUB_OUTPUT: output,
  };

  return {
    repo,
    remote,
    script,
    output,
    ghLog,
    env,
    run: () => {
      try {
        const stdout = execFileSync('bash', [script], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
      }
    },
    branchesOnRemote: () => execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => line.split('\t')[1].replace('refs/heads/', '')).sort(),
    mainOnRemote: () => execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, encoding: 'utf8' }).trim(),
  };
}

/** Um commit novo no repo, como o passo "Commit state to main" faria. */
function commitState(repo: string, marker: string): string {
  fs.writeFileSync(path.join(repo, '.kiro', 'state', 'STATE.md'), `# estado ${marker}\n`);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', `chore(continuity): sync ${marker}`], { cwd: repo, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('publicação do estado do projeto', () => {
  it('publica direto na main e nem tenta abrir PR', () => {
    const box = sandbox();
    const sha = commitState(box.repo, 'direto');

    const result = box.run();

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('publicado direto na main');
    expect(fs.readFileSync(box.output, 'utf8')).toContain('published=direct');
    expect(box.mainOnRemote()).toBe(sha);
    expect(box.branchesOnRemote()).toEqual(['main']);
    expect(fs.existsSync(box.ghLog) ? fs.readFileSync(box.ghLog, 'utf8') : '').toBe('');
  });

  it('com a main protegida, abre PR e mergeia (squash)', () => {
    const box = sandbox({ rejectsMainPush: true });
    commitState(box.repo, 'via-pr');

    const result = box.run();

    expect(result.code).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain('push direto para a main recusado');
    expect(out).toContain('protected branch hook declined');
    expect(out).toContain('mergeado (squash)');
    const outputs = fs.readFileSync(box.output, 'utf8');
    expect(outputs).toContain('published=pr');
    expect(outputs).toContain('pr=42');
    const branches = box.branchesOnRemote();
    expect(branches.filter((branch) => branch.startsWith('chore/continuity-state-'))).toHaveLength(1);
    expect(branches).toContain('main');
  });

  it('quando o PR não pode ser aberto, mostra o erro, publica o branch e sai com 0', () => {
    const box = sandbox({
      rejectsMainPush: true,
      ghCreate: { code: 1, message: 'GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' },
    });
    commitState(box.repo, 'sem-pr');

    const result = box.run();

    expect(result.code).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain('::warning::gh pr create falhou');
    expect(out).toContain('is not permitted to create or approve pull requests');
    expect(out).toContain('no artefato desta run');
    expect(fs.readFileSync(box.output, 'utf8')).toContain('published=branch');
    expect(box.branchesOnRemote().some((branch) => branch.startsWith('chore/continuity-state-'))).toBe(true);
  });

  it('sem mudança de estado, não publica nada', () => {
    const box = sandbox();
    const before = box.mainOnRemote();

    const result = execFileSync('bash', [box.script], {
      cwd: box.repo,
      env: { ...box.env, CHANGED: 'false' },
      encoding: 'utf8',
    });

    expect(result.trim()).toBe('');
    expect(box.mainOnRemote()).toBe(before);
    expect(box.branchesOnRemote()).toEqual(['main']);
  });

  it('o workflow roda o artefato do estado sempre que o estado muda', () => {
    const workflow = fs.readFileSync(WORKFLOW, 'utf8');
    const upload = workflow.slice(workflow.indexOf('- name: Upload state artifact'));
    expect(upload).toContain('uses: actions/upload-artifact@v4');
    expect(upload).toContain('always()');
    expect(upload).toContain(".kiro/state");
    expect(upload).toContain('public/state.json');
    // Nada de esconder o erro do `gh`: era assim que o passo mentia.
    expect(extractRun(workflow, STEP)).not.toContain('2>/dev/null');
  });
});
