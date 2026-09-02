import assert from "node:assert/strict";
import test from "node:test";

import { renderTestPlanK6Script } from "../runner/k6-scenario-script-renderer.mjs";

test("configured latency and error thresholds remain result-only in runner-generated k6", () => {
  const script = renderTestPlanK6Script({
    environment: { baseUrl: "https://example.test" },
    scenarios: [{
      scenario: { id: "scenario-1", name: "Scenario 1" },
      workload: {
        executor: "constant-vus",
        config: {
          vus: 1,
          duration: "5s",
          thresholds: { p95Ms: 1, errorRate: 0.001 },
        },
      },
      flows: [{
        flow: { id: "flow-1", name: "Flow 1" },
        steps: [{
          id: "step-1",
          name: "GET root",
          type: "request",
          execution: { method: "GET", path: "/" },
          validation: { expectedStatus: 200 },
          tags: [],
        }],
      }],
    }],
  });

  assert.doesNotMatch(script, /http_req_failed\{scenario:/);
  assert.doesNotMatch(script, /http_req_duration\{scenario:/);
  assert.doesNotMatch(script, /rate<0\.001/);
  assert.doesNotMatch(script, /p\(95\)<1(?:\D|$)/);
  assert.doesNotMatch(script, /abortOnFail:\s*true/);
  assert.match(script, /abortOnFail:\s*false/);
});
