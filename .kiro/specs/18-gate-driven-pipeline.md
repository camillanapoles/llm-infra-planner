# SPEC 18: Gate-driven pipeline (health trigger · issue → test → next issue)

## Description

Turn the project's work queue into an executable flow: a **health trigger** that
checks for the *non-existence* of open work, CI errors and missing tests, and a
**cycle** where every completed issue is tested and delivered together with the
instruction of the next one — all of it answering a single JSON object with
`id`, `message`, `attachments`, `status`, `nextIssue` and exit code `0/1/2`.

The blueprint runs as GitHub Actions gates: the exit code of each task is the
gate, and the JSON is the hand-off between tasks.

## Requirements

### R1 — Health trigger
- `npm run pipeline -- health` verifies three negatives: **no open issues**,
  **no CI run with error**, **no missing/failing tests**.
- While it is not positive the verdict is `continuity` (exit 1): there is work in
  flight, so the pipeline continues instead of declaring the project ready.
- Positive → exit 0 with `nextIssue: null`.
- A source that cannot be read (GitHub unreachable, `--tests=skip`) is reported
  as a blocker with its reason; it never silently counts as positive.
- No roadmap at all → exit 2 (structural): the queue is the source of truth.

### R2 — Next issue, indexed
- `npm run pipeline -- next [--from T-xxx]` returns the head of the queue as a
  `NextIssue`: id, `index` (position in the full roadmap sequence), queue
  position/total, title, phase, spec, `verify`, paths, `acceptance`, a ready
  `instruction`, `blockedBy` and `actionable`.
- A task without `verify` cannot claim acceptance: the instruction says
  `sem teste definido — declare verify no roadmap antes de executar`.

### R3 — Complete = test then deliver (+ next instruction)
- `npm run pipeline -- complete T-xxx` runs the task's `verify`.
- **Success** → the task is marked `done` in the roadmap (with evidence), a gate
  and an event are recorded in the continuity ledger, the check log and the next
  issue's briefing (`.kiro/state/pipeline/next-<id>.md`) are attached as
  artifacts, and the response carries the next indexed issue.
- **Verification failure** → **error type 1** (exit 1): the log is attached, the
  continuity info (resume point, blockers, last sync — read from the ledger *or*
  the versioned snapshot) travels in `details.continuity`, and `nextIssue` is the
  **same** issue with `reason: "retry"`.
- **Structural failure** (unknown task, task without `verify`, unreadable
  roadmap) → **error type 2** (exit 2).
- Re-completing a task that is already `done` is a no-op: exit 0, nothing is
  re-tested or rewritten.

### R4 — One JSON contract for every action
- Every action of the pipeline answers the same object (see `scripts/lib/result.ts`):
  `id`, `action`, `status`, `message`, `attachments[]` (`path`, `filename`,
  `kind`, `bytes`), `nextIssue`, `exitCode`, `at`, `actor`, `details`.
- `exitCode` is **derived** from `status`/`errorType` — a JSON cannot claim
  `success` while the shell sees non-zero.
- The JSON always goes to stdout (it is the contract); `--text` adds a human
  summary on stderr and `--summary` writes it to the Actions run summary.

### R5 — Blueprint as gates (GitHub Actions)
- `.github/workflows/pipeline.yml` implements the flow: `gate` →
  `instruction` (not positive) | `ready` (positive); `complete` is dispatchable.
- The workflow is triggered manually, daily (schedule) and **by the completion
  of CI/Continuity gate** (`workflow_run`) — the automatic trigger.
- Type 2 turns the job red; type 1 is a warning with the JSON as evidence.
- Artifacts (JSON + briefings + logs) are uploaded on every run, and on `main`
  the state is committed back.

## Acceptance

- `npm test` covers the contract and the core: exit-code mapping, health verdicts
  (positive/continuity/type 2), queue indexing, retry semantics, acceptance text.
- `npm run verify:all` includes a pipeline check (the CLI answers the contract).
- Manual proofs recorded in `PIPELINE.md` (success, failure type 1, structural
  type 2, idempotency, next with attachment).

## Notes

Issues are disabled in this repository, so the work items come from the indexed
roadmap (`T-xxx`) and `has_issues` is consulted first: enabling GitHub Issues
switches the source with no code change.
