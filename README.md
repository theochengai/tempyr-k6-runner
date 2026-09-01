# Tempyr k6 Runner

Public, generic k6 execution host for Tempyr. Customers fork this repository and connect their fork from Tempyr Project Settings.

This repository intentionally contains no Tempyr application source code, customer test data, target credentials, or long-lived Tempyr secrets in source control.

## Manual smoke mode

Run the **Run k6** workflow manually with no `run_id`. The default target is Grafana QuickPizza:

```text
https://quickpizza.grafana.com/api/get
```

The workflow performs a deliberately small 1-VU, 10-second smoke test. QuickPizza is a shared public demo target, so this mode is only for validating the GitHub-hosted k6 runner path, not for high load.

## Tempyr-dispatched mode

Tempyr keeps durable Run and queue state in D1. A Project connects one verified fork of this repository. When a Run is accepted, Tempyr freezes that Project runner binding into the execution job and dispatches the connected fork.

The workflow receives only:

- `run_id` — the exact Tempyr Run to execute.
- `execution_token` — a short-lived Tempyr credential scoped to that Run, Project, Workspace, and verified runner repository.

The fork then executes its own public runner client:

```text
run_id + short-lived execution_token
  ↓
claim that exact Run from Tempyr
  ↓
receive the frozen execution plan
  ↓
resolve runtime-only Environment values after the execution lease is valid
  ↓
compile + execute k6 inside this GitHub-hosted runner
  ↓
heartbeat lease and publish phase progress
  ↓
post terminal metrics/raw summary back to Tempyr
```

Run-specific claim is authoritative before any target traffic is generated. If an at-least-once dispatch causes a duplicate workflow to start, only the workflow that acquires the valid D1 execution lease can execute the Run.

Tempyr's authenticated completion callback and D1/R2 state remain authoritative for Run status and persisted reports.

The generated k6 script emits frozen authored-request tags such as:

```text
pt_step_id
pt_flow_id
pt_name
pt_method
pt_path
```

These tags preserve the immutable authored API identity frozen into each Run without depending on resolved runtime URLs.

## No customer repository secrets required

A connected fork does **not** need any of the old Tempyr bootstrap secrets:

- no `PERFTEST_SOURCE_TOKEN`
- no shared `PERF_RUNNER_TOKEN`
- no GitHub token for the private `theochengai/tempyr` application repository

Tempyr's GitHub App gets short-lived Actions access to the connected fork at dispatch time. The workflow receives a separate short-lived execution credential as a workflow input and masks it before execution. The credential expires automatically and cannot authorize another Run or another runner repository.

Do not echo or persist the `execution_token` in workflow logs or artifacts.

## Connecting a fork

1. Fork `theochengai/tempyr-k6-runner` into the GitHub account or organization that should own execution.
2. Keep `.github/workflows/run-k6.yml` enabled on the fork.
3. In Tempyr, open the Project's settings and find **Execution Runner**.
4. Enter the fork as `owner/repo` and continue to GitHub.
5. Install/authorize the Tempyr GitHub App for that repository.

Tempyr verifies that the selected repository is a fork of this canonical runner and that the App installation can access it. The canonical Tempyr-owned runner itself is not accepted as a customer Project runner.

## Tempyr service configuration

The Tempyr deployment owns the GitHub App credentials. Customer forks do not receive or store them.

The Tempyr service requires, when runner connections are enabled:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`

The App should have the minimum repository permissions needed by the integration: read repository contents/metadata and dispatch/read Actions runs. Tempyr mints repository-scoped installation tokens on demand and does not persist them.

Optional execution variables remain service-owned, such as concurrency, dispatch lease, provider-start timeout, workflow name, and workflow ref.

## Compatibility and trust boundary

The old global runner token remains a Tempyr internal compatibility path during migration, but customer-owned forks do not use it. For a dispatched customer Run, Tempyr validates the short-lived credential against the durable `RunExecutionJob` before exposing the execution plan or runtime Environment credentials.

The Cloudflare Worker never runs k6. It owns authorization, Run state, snapshot/materialization, leases, and persistence; the connected GitHub-hosted runner owns actual k6 process execution.

## Current result pipeline

The standalone runner posts the k6 summary and normalized top-level metric summary back to Tempyr. Tempyr builds the persisted Run report from that evidence. Native first-party time-series normalization can continue to evolve independently without reintroducing private source checkout into customer forks.
