# PerfTest k6 Runner

Public, generic k6 execution host for PerfTest.

This repository intentionally contains no PerfTest application source code, customer test data, target credentials, or long-lived secrets in source control.

## Manual smoke mode

Run the **Run k6** workflow manually with no `run_id`. The default target is Grafana QuickPizza:

```text
https://quickpizza.grafana.com/api/get
```

The workflow performs a deliberately small 1-VU, 10-second smoke test. QuickPizza is a shared public demo target, so this mode is only for validating the GitHub-hosted k6 runner path, not for high load.

Manual smoke mode does not require or use Grafana Cloud Prometheus credentials.

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
  ├── stream real-time metrics to Grafana Cloud Prometheus
  └── keep the normal end-of-run summary/report callback to PerfTest
  ↓
heartbeat lease
  ↓
post terminal metrics/findings/result back to PerfTest
```

Run-specific claim is authoritative before any target traffic is generated. If an at-least-once dispatch causes a duplicate workflow to start, only the workflow that acquires the valid D1 execution lease can execute the Run.

Grafana Cloud telemetry is additive. PerfTest's authenticated completion callback and D1/R2 state remain authoritative for Run status and persisted reports.

### Grafana Cloud metric identity

Dispatched runs configure k6's Prometheus Remote Write output and use the PerfTest Run ID as a wide tag:

```text
testid=<PerfTest run_id>
```

The generated PerfTest k6 script also emits frozen authored-request tags such as:

```text
pt_step_id
pt_flow_id
pt_name
pt_method
pt_path
```

These labels let Grafana dashboards filter one Run by `testid` and break request metrics down by the API Step frozen into that Run rather than by dynamic runtime URLs.

To control Prometheus cardinality, the workflow disables default `url` and `name` system tags for dispatched runs. Canonical API identity should come from the `pt_*` tags instead.

## Required repository secrets for dispatched runs

Configure these Actions repository secrets on `theochengai/perftest-k6-runner`:

- `PERFTEST_SOURCE_TOKEN` — fine-grained GitHub token with **Contents: Read-only** access to `theochengai/perftest_poc` only.
- `PERF_CLOUDFLARE_API_BASE` — deployed PerfTest Worker/application URL. The runner normalizes it to `/api/v1`.
- `PERF_RUNNER_TOKEN` — shared secret that matches the Worker `PERF_RUNNER_TOKEN` secret.
- `K6_PROMETHEUS_RW_SERVER_URL` — Grafana Cloud Prometheus **Remote Write Endpoint**.
- `K6_PROMETHEUS_RW_USERNAME` — Grafana Cloud Prometheus **Username / Instance ID**.
- `K6_PROMETHEUS_RW_PASSWORD` — Grafana Cloud Access Policy token scoped to **`metrics:write`**. The variable is named `PASSWORD` because k6 uses HTTP Basic Authentication; do not store an account password here.

The workflow is only triggered by `workflow_dispatch`; it does not run on pull requests, so public fork/PR code cannot automatically receive these secrets.

The dispatched execution step additionally configures:

- `K6_OUT=experimental-prometheus-rw` — enable k6 Prometheus Remote Write output.
- `K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99)` — export p95 and p99 time-series gauges for Trend metrics.
- `K6_PROMETHEUS_RW_STALE_MARKERS=true` — mark the Run's observed Prometheus series stale when the test ends.
- `K6_SYSTEM_TAGS` without `url`/`name` — avoid resolved-URL cardinality and preserve authored API grouping through `pt_*` labels.

No Grafana credentials are passed to manual smoke mode.

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

## Grafana dashboard

Grafana's official **k6 Prometheus** dashboard can be imported with dashboard ID:

```text
19665
```

Use the Grafana Cloud Prometheus datasource. PerfTest-specific dashboard work should use `testid` as the Run selector and the frozen `pt_*` labels for authored API breakdowns.

## Future hardening

The private source checkout is an MVP bootstrap. A productized runner should consume a versioned standalone runner package or short-lived executable bundle instead of checking out the private application repository.
