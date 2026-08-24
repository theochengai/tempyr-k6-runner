# PerfTest k6 Runner

Public, generic k6 execution backend for PerfTest.

This repository intentionally contains no PerfTest application source code, customer test data, target credentials, or long-lived secrets.

## Phase 1: runner smoke test

Run the **Run k6** workflow manually and provide a public HTTP(S) endpoint such as the Astronomy Shop `/api/products` endpoint. The workflow performs a deliberately small 1-VU, 10-second smoke test.

This first phase verifies that a GitHub-hosted runner can install k6 and reach the load-test target independently from PerfTest orchestration.

## Planned PerfTest integration

PerfTest will keep Run state and queue state in D1. Its dispatcher will start this workflow with a `run_id`; the runner will fetch a short-lived executable bundle from PerfTest, execute k6, and report the result back.

The public runner repository remains generic: `run_id -> executable bundle -> k6 -> result callback`.
