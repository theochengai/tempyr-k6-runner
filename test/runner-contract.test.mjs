import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/run-k6.yml", "utf8");
const client = await readFile("runner/tempyr-run.mjs", "utf8");

test("automatic runs are self-contained and use a short-lived execution credential", () => {
  assert.match(workflow, /execution_token:/);
  assert.match(workflow, /TEMPYR_EXECUTION_TOKEN/);
  assert.match(workflow, /node runner\/tempyr-run\.mjs/);
  assert.doesNotMatch(workflow, /theochengai\/tempyr\b/);
  assert.doesNotMatch(workflow, /PERFTEST_SOURCE_TOKEN/);
  assert.doesNotMatch(workflow, /PERF_RUNNER_TOKEN/);
  assert.doesNotMatch(workflow, /perftest-src|tempyr-src/);
});

test("runner claims the exact Run before resolving runtime Environment values or executing k6", () => {
  const claim = client.indexOf("/claim");
  const runtimeEnvironment = client.indexOf("/runtime-environment");
  const runK6 = client.indexOf("await runK6(");
  assert.ok(claim >= 0, "exact Run claim must exist");
  assert.ok(runtimeEnvironment > claim, "runtime Environment values must be requested after claim");
  assert.ok(runK6 > runtimeEnvironment, "k6 must start only after runtime Environment resolution");
});

test("runner reports terminal state through the authenticated execution job boundary", () => {
  assert.match(client, /\/complete/);
  assert.match(client, /lease_token: job\.leaseToken/);
  assert.match(client, /authorization: `Bearer \$\{executionToken\}`/);
});

test("runner captures and uploads native time-series evidence before successful completion", () => {
  assert.match(client, /normalizeK6JsonOutput/);
  assert.match(client, /"--out"/);
  assert.match(client, /`json=\$\{prepared\.samplePath\}`/);
  assert.match(
    client,
    /await safelyUploadTimeSeries\([\s\S]*?await tempyrApi\(`\/internal\/execution-jobs\/\$\{encodeURIComponent\(runId\)\}\/complete`/,
  );
  assert.match(client, /time_series_artifact: artifact/);
});
