/**
 * Contrato JSON único das ações do pipeline (e do agente).
 *
 *   Toda ação responde UM objeto com:
 *     id          ── `<ação>@<ISO>`: identifica a execução (e o artefato, se houver)
 *     action      ── qual ação rodou
 *     status      ── `success` | `continuity` | `error` (string, nunca boolean)
 *     message     ── frase legível; pode vir vazia, pode vir o log
 *     attachments ── anexos GERADOS (path + filename), quando existirem
 *     nextIssue   ── a issue SEGUINTE (indexada) em sucesso; a MESMA em falha;
 *                    `null` quando não há fila
 *     exitCode    ── 0 sucesso · 1 erro tipo 1 (verificação/continuidade) · 2 erro tipo 2 (estrutural)
 *     at          ── timestamp ISO
 *
 * O status é o vocabulário; o exitCode é o que o shell/Actions enxerga. Os dois
 * são derivados um do outro por construção (ver `exitCodeFor`), nunca digitados
 * à mão — assim um JSON não pode dizer `success` com exit 1.
 */
import fs from 'node:fs';
import path from 'node:path';

export const EXIT = { success: 0, continuity: 1, fatal: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export type ResultStatus = 'success' | 'continuity' | 'error';
/**
 * Sub-tipo do erro — o que separa "tente de novo" de "pare e conserte o fluxo":
 *   1 = erro tipo 1: a ação rodou e REPROVOU (verificação vermelha, teste falhando).
 *       Há trabalho a continuar no mesmo item; o log vai anexado e a issue volta.
 *   2 = erro tipo 2: estrutural — o pipeline não tem como executar (entrada inválida,
 *       tarefa inexistente, sem instrução de teste, roadmap ilegível).
 */
export type ErrorType = 1 | 2;

export interface Attachment {
  /** Caminho relativo à raiz do projeto (o que alguém clona vê). */
  path: string;
  filename: string;
  /** Natureza do anexo: json, md, log… */
  kind: string;
  bytes?: number;
}

export interface NextIssue {
  id: string;
  /** Posição 1-based na sequência completa do roadmap (a issue "indexada"). */
  index: number;
  /** Posição na fila de abertas (1 = próxima a executar). */
  queuePosition: number;
  queueTotal: number;
  title: string;
  phase?: string;
  phaseName?: string;
  spec?: string;
  verify?: string;
  paths?: string[];
  /** O teste de aceite em uma frase: o que precisa retornar 0. */
  acceptance: string;
  /** Instrução pronta para executar (texto), no espírito BPMN: tarefa + teste + escopo. */
  instruction: string;
  /** Tarefas abertas que vêm antes e impedem começar (vazio = acionável). */
  blockedBy: string[];
  actionable: boolean;
  /** `retry` quando a issue é a mesma de antes (falha); `next` quando é a seguinte. */
  reason: 'next' | 'retry';
}

export interface ActionResult<T = Record<string, unknown>> {
  id: string;
  action: string;
  status: ResultStatus;
  /** Só existe quando `status` é `error`: 1 = reprovou, 2 = estrutural. */
  errorType?: ErrorType;
  message: string;
  attachments: Attachment[];
  nextIssue: NextIssue | null;
  exitCode: ExitCode;
  at: string;
  actor?: string;
  details?: T;
}

export function exitCodeFor(status: ResultStatus, errorType: ErrorType = 2): ExitCode {
  if (status === 'success') return EXIT.success;
  if (status === 'continuity') return EXIT.continuity;
  return errorType === 1 ? EXIT.continuity : EXIT.fatal;
}

export interface MakeResultInput<T> {
  action: string;
  status: ResultStatus;
  errorType?: ErrorType;
  message: string;
  attachments?: Attachment[];
  nextIssue?: NextIssue | null;
  details?: T;
  at?: string;
  actor?: string;
}

/** Monta o objeto-resposta; `exitCode` e `id` são derivados, nunca informados soltos. */
export function makeResult<T = Record<string, unknown>>(input: MakeResultInput<T>): ActionResult<T> {
  const at = input.at ?? new Date().toISOString();
  const errorType = input.status === 'error' ? input.errorType ?? 2 : input.errorType;
  return {
    id: `${input.action}@${at}`,
    action: input.action,
    status: input.status,
    ...(errorType === undefined ? {} : { errorType }),
    message: input.message,
    attachments: input.attachments ?? [],
    nextIssue: input.nextIssue ?? null,
    exitCode: exitCodeFor(input.status, errorType ?? 2),
    at,
    actor: input.actor ?? process.env.GITHUB_ACTOR ?? process.env.USER ?? undefined,
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

/** Descreve um arquivo já escrito como anexo (bytes lidos do disco quando existir). */
export function attachment(root: string, relativePath: string, kind: string): Attachment {
  const full = path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath);
  let bytes: number | undefined;
  try {
    bytes = fs.statSync(full).size;
  } catch {
    bytes = undefined; // anexo anunciado antes de existir é omitido do tamanho, não inventado
  }
  return {
    path: relativePath,
    filename: path.basename(relativePath),
    kind,
    ...(bytes === undefined ? {} : { bytes }),
  };
}

export interface EmitOptions {
  /** Também escreve um resumo legível no stderr (stdout fica só com o JSON). */
  text?: boolean;
  /** Loga no resumo do GitHub Actions, quando existir. */
  summary?: boolean;
  out?: NodeJS.WriteStream;
}

/**
 * Publica o resultado. O JSON vai para o stdout SEMPRE — é o contrato, não uma
 * opção de formato. Quem quiser olhar com os olhos usa `--text`/summary.
 */
export function emitResult(result: ActionResult, options: EmitOptions = {}): ExitCode {
  const out = options.out ?? process.stdout;
  out.write(`${JSON.stringify(result, null, 2)}\n`);

  const headline = `[${result.status}] ${result.action} — ${result.message}`;
  if (options.text) process.stderr.write(`${headline}\n`);
  if (result.nextIssue) {
    const issue = result.nextIssue;
    const line = `  → próxima: ${issue.id} (${issue.reason}) · teste: ${issue.verify ?? 'sem instrução de teste'}`;
    if (options.text) process.stderr.write(`${line}\n`);
  }
  if (options.summary && process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## ${headline}`, ''];
    if (result.attachments.length) {
      lines.push('**Anexos**', '', ...result.attachments.map(a => `- \`${a.path}\` (${a.kind}${a.bytes === undefined ? '' : `, ${a.bytes} B`})`), '');
    }
    if (result.nextIssue) {
      lines.push('**Próxima issue**', '', '```', result.nextIssue.instruction, '```', '');
    }
    lines.push(`<sub>exit ${result.exitCode} · ${result.id}</sub>`, '');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  return result.exitCode;
}
