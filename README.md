# PerfTest k6 Runner

Public, generic k6 execution host for PerfTest.

This repository intentionally contains no PerfTest application source code, customer test data, target credentials, or long-lived secrets in source control.

## Manual smoke mode

Run the **Run k6** workflow manually with no `run_id`. The default target is Grafana QuickPizza:

```text
https://quickpizza.grafana.com/api/get
```

The workflow performs a deliberately small 1-VU, 10-second smoke test. QuickPizza is a shared public demo target, so this mode is only for validating the GitHub-hosted k6 runner path, not for high load.

## PerfTest-dispatched mode

PerfTest keeps durable Run and queue state in D1. Its Cloudflare dispatcher starts this workflow with a specific `run_id`.

For the POC, the workflow then:

```text
run_id
  ↓
checkout private perftest_poc execution source (read-only token)
  ↓
claim that exact Run from the deployed PerfTest Worker
  ↓
prepare + execute k6
  ↓
heartbeat lease
  ↓
post terminal metrics/findings/result back to PerfTest
```

Run-specific claim is authoritative before any target traffic is generated. If an at-least-once dispatch causes a duplicate workflow to start, only the workflow that acquires the valid D1 execution lease can execute the Run.

## Required repository secrets for dispatched runs

Configure these Actions repository secrets on `theochengai/perftest-k6-runner`:

- `PERFTEST_SOURCE_TOKEN` — fine-grained GitHub token with **Contents: Read-only** access to `theochengai/perftest_poc` only.
- `PERF_CLOUDFLARE_API_BASE` — deployed PerfTest Worker/application URL. The runner normalizes it to `/api/v1`.
- `PERF_RUNNER_TOKEN` — shared secret that matches the Worker `PERF_RUNNER_TOKEN` secret.

The workflow is only triggered by `workflow_dispatch`; it does not run on pull requests, so public fork/PR code cannot automatically receive these secrets.

## PerfTest Worker dispatch configuration

The deployed PerfTest Worker needs:

- `PERF_GITHUB_ACTIONS_TOKEN` — fine-grained token scoped to this public runner repository with **Actions: Read and write** permission.
- `PERF_RUNNER_TOKEN` — same runner API secret configured above.

Optional Worker variables:

- `PERF_MAX_CONCURRENT_RUNS` — PerfTest execution capacity. Current default: **5**.
- `PERF_GITHUB_ACTIONS_REPOSITORY` — defaults to `theochengai/perftest-k6-runner`.
- `PERF_GITHUB_ACTIONS_WORKFLOW` — defaults to `run-k6.yml`.
- `PERF_GITHUB_ACTIONS_REF` — defaults to `main`.
- `PERF_DISPATCH_LEASE_SECONDS` — short reservation lease before GitHub accepts a dispatch.
- `PERF_PROVIDER_START_TIMEOUT_SECONDS` — how long a dispatched workflow may wait before the job is eligible for recovery.

## Future hardening

The private source checkout is an MVP bootstrap. A productized runner should consume a versioned standalone runner package or short-lived executable bundle instead of checking out the private application repository.
