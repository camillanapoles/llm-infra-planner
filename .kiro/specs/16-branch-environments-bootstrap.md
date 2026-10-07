# SPEC 16: Repository bootstrap (branches · environments · Pages) without pushing

## Description

Branch and environment provisioning is normally a manual, local-git operation. This spec moves it into a **workflow that runs on `main`**: once it is merged, a single run creates the `dev` and `staging` branches, prepares the GitHub Environments, enables Pages when the token allows it, and dispatches the deploys — all through the GitHub API with the run's own `GITHUB_TOKEN`. No local `git push`, no personal access token, no clicking through settings.

The same design lets any ref (including a feature branch such as `arena/fe62ce6d-llm-infra-planner`) be **published without being pushed to another branch**, which is what makes review of in-progress work possible in this repository.

## Requirements

### Requirement 1: One-shot provisioning on `main`
**User Story:** As a repo owner, I want to merge one workflow and have every branch/environment/deploy step done for me.

**Acceptance Criteria:**
- `.github/workflows/bootstrap-repo.yml` triggers on `push` to `main` when any of the pipeline workflows change, and can be run manually (`workflow_dispatch`) with inputs:
  `source_ref`, `branch_source`, `create_branches`, `enable_pages`, `deploy`, `deploy_environments`, `docker`.
- Steps, all idempotent and individually reported:
  1. resolve the source commit (`source_ref` if given, else the triggering SHA);
  2. create `dev` and `staging` at that SHA — or fast-forward them (`PATCH /git/refs/heads/<b>` with `force=true`) when they already exist;
  3. create/refresh the `dev`, `staging`, `production` Environments (`PUT /environments/<name>`);
  4. enable Pages with the *GitHub Actions* source when not already enabled;
  5. dispatch `deploy-pages.yml` (and optionally `docker.yml`);
  6. write a summary with the three URLs and the equivalent manual commands.
- Permissions are declared explicitly and minimally: `contents: write`, `pages: write`, `id-token: write`, `actions: write`.
- Every failure that a token may not be allowed to perform degrades to `::notice`/`::warning` with the manual fallback (e.g. "enable Pages at Settings → Pages → Source: GitHub Actions") — the run never fails because of missing admin rights.
- Concurrency group `bootstrap-repo` prevents overlapping runs from racing on branch creation.

### Requirement 2: Publishing without pushing
**User Story:** As a developer (or an AI agent), I want my working branch published for review while `main`, `dev` and `staging` stay untouched.

**Acceptance Criteria:**
- Because the workflows live on the default branch, `gh workflow run deploy-pages.yml -f ref=<branch> -f environments=dev` builds `dev` from that branch and production/staging from theirs.
- The bootstrap workflow can do this too: `branch_source` selects the ref used by the dispatched deploy, while `source_ref` controls what `dev`/`staging` are created from.
- No workflow in this repository pushes commits or creates branches other than `dev`/`staging`; feature branches remain owner-controlled.
- The instructions are documented in the workflow header, in spec 13 and in the README, including the "restore the real branch" case (`gh workflow run deploy-pages.yml -f environments=dev` with no `ref`).

### Requirement 3: Environments aligned with the deploy targets
**User Story:** As a maintainer, I want GitHub Environments to mirror the environments the pipelines deploy to, so protection rules and secrets can be added later.

**Acceptance Criteria:**
- Environments `dev`, `staging`, `production` exist and are referenced by `.github/workflows/docker.yml` (`environment: ${{ matrix.env }}`); the Pages deploy uses the required `github-pages` environment.
- If the API cannot create an environment, the notice explains that GitHub creates it automatically on first deploy — no hard failure.
- Adding protection (required reviewers, wait timers, env-specific secrets) requires no workflow change: the reference is already there.

## Runbook

```bash
# 1) after merging this workflow into main it runs automatically.
#    Or run it by hand:
gh workflow run bootstrap-repo.yml
#    with options:
gh workflow run bootstrap-repo.yml \
  -f source_ref=main \
  -f branch_source=arena/fe62ce6d-llm-infra-planner \
  -f deploy_environments=dev \
  -f docker=true

# 2) publish any branch to an environment without pushing
gh workflow run deploy-pages.yml -f ref=arena/fe62ce6d-llm-infra-planner -f environments=dev

# 3) restore dev to its own branch
gh workflow run deploy-pages.yml -f environments=dev

# 4) inspect
gh run list --workflow=deploy-pages.yml --limit 5
gh api repos/{owner}/{repo}/branches --jq '.[].name'
```

## Files

```
.github/workflows/bootstrap-repo.yml   provisioning workflow (runs on main)
.github/workflows/deploy-pages.yml     consumes the branches/environments it creates
.github/workflows/docker.yml           references the same environments (GHCR)
README.md                              one-time setup section
```
