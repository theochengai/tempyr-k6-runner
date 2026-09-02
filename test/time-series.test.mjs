import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeK6JsonOutput } from "../runner/run-time-series.mjs";

test("normalizes k6 JSON output into the Tempyr native time-series artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tempyr-time-series-test-"));
  const inputPath = join(dir, "samples.jsonl");
  const startedAt = "2026-09-02T12:00:00.000Z";
  const endedAt = "2026-09-02T12:00:10.000Z";
  const apiTags = {
    pt_step_id: "step_pizza",
    pt_flow_id: "flow_order",
    pt_name: "Create pizza",
    pt_method: "POST",
    pt_path: "/api/pizza",
  };
  const tagTags = { pt_tag_id: "checkout" };
  const samples = [
    point("http_reqs", 1, "2026-09-02T12:00:01.000Z", apiTags),
    point("http_req_failed", 0, "2026-09-02T12:00:01.000Z", apiTags),
    point("http_req_duration", 100, "2026-09-02T12:00:01.000Z", apiTags),
    point("http_reqs", 1, "2026-09-02T12:00:02.000Z", apiTags),
    point("http_req_failed", 1, "2026-09-02T12:00:02.000Z", apiTags),
    point("http_req_duration", 300, "2026-09-02T12:00:02.000Z", apiTags),
    point("http_reqs", 1, "2026-09-02T12:00:06.000Z", apiTags),
    point("http_req_failed", 0, "2026-09-02T12:00:06.000Z", apiTags),
    point("http_req_duration", 200, "2026-09-02T12:00:06.000Z", apiTags),
    point("pt_tag_requests", 1, "2026-09-02T12:00:01.000Z", tagTags),
    point("pt_tag_failed", 1, "2026-09-02T12:00:01.000Z", tagTags),
    point("pt_tag_duration", 120, "2026-09-02T12:00:01.000Z", tagTags),
    point("http_reqs", 1, "2026-09-02T12:00:11.000Z", apiTags),
  ];

  await writeFile(inputPath, `${samples.map(JSON.stringify).join("\n")}\nnot-json\n`, "utf8");
  try {
    const normalized = await normalizeK6JsonOutput({
      inputPath,
      runId: "run_test",
      startedAt,
      endedAt,
    });

    assert.equal(normalized.artifact.schemaVersion, 1);
    assert.equal(normalized.artifact.runId, "run_test");
    assert.equal(normalized.artifact.bucketMs, 5000);
    assert.deepEqual(normalized.artifact.executionWindow, { startedAt, endedAt });
    assert.equal(normalized.diagnostics.malformedLines, 1);
    assert.equal(normalized.diagnostics.ignoredSamples, 1);
    assert.ok(normalized.diagnostics.sizeBytes > 0);

    assert.equal(normalized.artifact.apis.length, 1);
    const api = normalized.artifact.apis[0];
    assert.deepEqual(
      { stepId: api.stepId, flowId: api.flowId, name: api.name, method: api.method, path: api.path },
      {
        stepId: "step_pizza",
        flowId: "flow_order",
        name: "Create pizza",
        method: "POST",
        path: "/api/pizza",
      },
    );
    assert.equal(api.points.length, 2);
    assert.deepEqual(api.points[0], {
      timestamp: "2026-09-02T12:00:00.000Z",
      requests: 2,
      rps: 0.4,
      p95Ms: 290,
      p99Ms: 298,
      errorRate: 0.5,
    });
    assert.deepEqual(api.points[1], {
      timestamp: "2026-09-02T12:00:05.000Z",
      requests: 1,
      rps: 0.2,
      p95Ms: 200,
      p99Ms: 200,
      errorRate: 0,
    });

    assert.equal(normalized.artifact.tags.length, 1);
    assert.deepEqual(normalized.artifact.tags[0], {
      tagId: "checkout",
      name: "checkout",
      points: [{
        timestamp: "2026-09-02T12:00:00.000Z",
        requests: 1,
        rps: 0.2,
        p95Ms: 120,
        p99Ms: 120,
        errorRate: 1,
      }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function point(metric, value, time, tags) {
  return { type: "Point", metric, data: { time, value, tags } };
}
