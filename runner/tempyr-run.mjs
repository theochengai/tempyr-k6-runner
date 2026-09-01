#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTestPlanVariableEnvironment, renderTestPlanK6Script } from "./k6-scenario-script-renderer.mjs";

const runId = String(process.env.TEMPYR_RUN_ID || "").trim();
const executionToken = String(process.env.TEMPYR_EXECUTION_TOKEN || "").trim();
const apiBase = normalizeApiBase(process.env.TEMPYR_API_BASE || "https://tempyr.perftest.workers.dev");
const heartbeatMs = positiveInteger(process.env.TEMPYR_HEARTBEAT_MS, 60_000);
const trendStats = "avg,min,med,max,p(90),p(95),p(99)";

if (!runId) throw new Error("TEMPYR_RUN_ID is required");
if (!executionToken) throw new Error("TEMPYR_EXECUTION_TOKEN is required");

let job = null;
let runtimeEnvironment = null;
let artifactDir = null;
let stage = "prepare";
let heartbeat = null;

try {
  const claimed = await tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/claim`, { method: "POST" });
  job = claimed?.data?.job || null;
  if (!job) {
    console.log(`Tempyr run ${runId} is no longer claimable; exiting without target traffic`);
    process.exitCode = 0;
  } else {
    heartbeat = setInterval(() => {
      tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/heartbeat`, {
        method: "POST",
        body: { lease_token: job.leaseToken },
      }).catch((error) => console.error(`heartbeat failed for ${runId}: ${error.message}`));
    }, heartbeatMs);
    heartbeat.unref?.();
    await executeClaimedRun();
  }
} catch (error) {
  const message = safeMessage(error);
  console.error(`Tempyr run ${runId} failed: ${message}`);
  if (job?.leaseToken) {
    const preparationFailure = stage === "prepare";
    await tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/complete`, {
      method: "POST",
      body: {
        lease_token: job.leaseToken,
        status: "failed",
        stop_reason: preparationFailure ? "preparation_failed" : "execution_failed",
        failure_stage: preparationFailure ? "prepare" : stage,
        summary: preparationFailure ? `${message}. No load was sent to the target.` : message,
        metric_summary: null,
        findings: [],
      },
    }).catch((completionError) => console.error(`failed to persist Tempyr run failure: ${completionError.message}`));
  }
  process.exitCode = 1;
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (artifactDir) await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
}

async function executeClaimedRun() {
  if (!job.executionPlan?.scenarios?.length || !job.executionSnapshot) {
    throw new Error("Claimed job does not contain a frozen execution snapshot and materialized execution plan");
  }

  const runtime = await tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/runtime-environment`, {
    method: "POST",
    body: { lease_token: job.leaseToken },
  });
  runtimeEnvironment = runtime?.data?.runtimeEnvironment;
  if (!runtimeEnvironment) throw new Error("Authorized runtime Environment values were not returned");

  await setSubtask("preparing", "compile-executable-test");
  const prepared = await prepareExecution(job.executionPlan, runtimeEnvironment);
  artifactDir = prepared.artifactDir;

  await setPhase("ready");
  await setSubtask("ready", "publish-executable-artifact");
  await setSubtask("ready", "wait-for-runner");
  await setPhase("executing");
  const executionMode = prepared.plan.executionMode;
  await setSubtask("executing", executionMode === "validation" ? "start-prepared-validation" : "start-prepared-load-test");
  await setSubtask("executing", executionMode === "validation" ? "execute-complete-journey" : "generate-target-traffic");
  stage = "execute";

  const startedAt = new Date().toISOString();
  const result = await runK6(prepared, runtimeEnvironment);
  const endedAt = new Date().toISOString();
  await setSubtask("executing", executionMode === "validation" ? "collect-validation-evidence" : "collect-execution-evidence");

  await setPhase("processing_results");
  await setSubtask("processing_results", "normalize-execution-evidence");
  stage = "process_results";
  const outcome = await buildOutcome(prepared, result, startedAt, endedAt);
  await setSubtask("processing_results", "build-findings-and-report");
  await setSubtask("processing_results", "persist-final-results");

  await tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/complete`, {
    method: "POST",
    body: {
      lease_token: job.leaseToken,
      status: outcome.status,
      stop_reason: outcome.stopReason,
      summary: outcome.summary,
      metric_summary: outcome.metricSummary,
      findings: [],
      raw_artifact: outcome.rawArtifact,
    },
  });
  await writeStepSummary(outcome, prepared.plan);
  if (outcome.status === "failed") process.exitCode = 1;
}

async function prepareExecution(executionPlan, runtime) {
  const dir = await mkdtemp(join(tmpdir(), "tempyr-k6-"));
  const scenarios = [];
  for (let scenarioIndex = 0; scenarioIndex < executionPlan.scenarios.length; scenarioIndex += 1) {
    const entry = executionPlan.scenarios[scenarioIndex];
    const datasets = [];
    for (const dataset of entry.datasets || []) {
      if (!Array.isArray(dataset.rows)) throw new Error(`Dataset ${dataset.fileName || dataset.id} was not materialized for execution`);
      const dataDir = join(dir, "data", `scenario-${scenarioIndex + 1}`);
      await mkdir(dataDir, { recursive: true });
      const fileName = `${dataset.id}.json`;
      await writeFile(join(dataDir, fileName), JSON.stringify(dataset.rows), "utf8");
      datasets.push({
        ...dataset,
        rows: undefined,
        dataFile: `./data/scenario-${scenarioIndex + 1}/${fileName}`,
      });
    }
    scenarios.push({
      ...entry,
      flows: normalizeFlows(entry.flows || []),
      datasets,
      variableNames: Object.keys(entry.variables || {}),
    });
  }

  const safeEnvironment = {
    ...executionPlan.environment,
    secrets: Object.fromEntries(Object.keys(runtime.secrets || {}).map((name) => [name, null])),
    authValues: {
      headers: (runtime.authValues?.headers || []).map((item) => ({ name: item.name, value: null })),
      cookies: (runtime.authValues?.cookies || []).map((item) => ({ name: item.name, value: null })),
    },
  };
  const plan = { ...executionPlan, environment: safeEnvironment, scenarios };
  let script = renderTestPlanK6Script({ environment: safeEnvironment, scenarios, guardrail: executionPlan.guardrail || {} });
  if (executionPlan.executionMode === "validation") script = applyValidationWorkload(script, plan);
  const scriptPath = join(dir, "script.js");
  const summaryPath = join(dir, "summary.json");
  await writeFile(scriptPath, script, "utf8");
  return { artifactDir: dir, scriptPath, summaryPath, plan };
}

function applyValidationWorkload(baseScript, plan) {
  const workload = plan.validationWorkload;
  if (!workload?.executor || !workload?.config) throw new Error("Validation execution is missing its frozen validation workload");
  const option = { ...workload.config, executor: workload.executor, exec: "validation_all" };
  const optionsBlock = `export const options = {\n  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],\n  scenarios: {\n    validation: ${JSON.stringify(option, null, 4)}\n  },\n  thresholds: {\n    ${validationMetricThresholds(plan.scenarios)}\n  }\n};`;
  const replaced = baseScript.replace(
    /export const options = \{[\s\S]*?\n\};\n\nexport function scenario_0\(\)/,
    `${optionsBlock}\n\nexport function scenario_0()`,
  );
  if (replaced === baseScript) throw new Error("Unable to apply validation workload to generated k6 script");
  const calls = plan.scenarios.map((_entry, index) => `  scenario_${index}();`).join("\n");
  return `${replaced}\n\nexport function validation_all() {\n${calls}\n}\n`;
}

async function runK6(prepared, runtime) {
  const env = {
    ...process.env,
    ...buildTestPlanVariableEnvironment(prepared.plan.scenarios || [], {
      ...prepared.plan.environment,
      secrets: runtime.secrets || {},
      authValues: runtime.authValues || { headers: [], cookies: [] },
    }),
  };
  const timeoutMs = executionTimeoutMs(prepared.plan);
  return new Promise((resolve, reject) => {
    const child = spawn("k6", [
      "run",
      prepared.scriptPath,
      "--summary-export",
      prepared.summaryPath,
      "--summary-trend-stats",
      trendStats,
    ], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code: Number(code ?? 1), signal, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

async function buildOutcome(prepared, result) {
  let summary = { metrics: {} };
  try { summary = JSON.parse(await readFile(prepared.summaryPath, "utf8")); } catch { /* k6 can fail before export */ }
  const metricSummary = buildMetricSummary(summary, prepared.plan.testPlan?.planType);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.timedOut) return outcome("stopped_by_guardrail", "k6_timeout", "k6 was stopped because it exceeded the guardrail execution timeout", metricSummary, summary);
  if (result.code !== 0 && /threshold/i.test(result.stderr || "")) return outcome("stopped_by_guardrail", "k6_threshold_abort", "k6 stopped early because configured latency or error thresholds were crossed", metricSummary, summary);
  if (result.code !== 0 && /DATASET_EXHAUSTED/.test(output)) return outcome("failed", "dataset_exhausted", "Prepared execution could not continue because a dataset ran out of rows", metricSummary, summary);
  if (result.code !== 0 && /ENVIRONMENT_TARGET_MISSING/.test(output)) return outcome("failed", "prepared_target_missing", "Prepared execution referenced an Environment target that was not available at runtime", metricSummary, summary);
  if (result.code !== 0) return outcome("failed", "k6_failed", "k6 execution failed before producing a successful engine completion", metricSummary, summary);
  const name = prepared.plan.testPlan?.name || "Test Plan";
  const text = prepared.plan.executionMode === "validation"
    ? `Validation completed for ${name}`
    : `Test Plan ${name} completed across ${(prepared.plan.scenarios || []).length} Scenario${(prepared.plan.scenarios || []).length === 1 ? "" : "s"}`;
  return outcome("completed", "completed", text, metricSummary, summary);
}

function outcome(status, stopReason, summary, metricSummary, rawArtifact) {
  return { status, stopReason, summary, metricSummary, rawArtifact };
}

function buildMetricSummary(summary, planType) {
  const duration = summary.metrics?.http_req_duration || {};
  const failed = summary.metrics?.http_req_failed || {};
  const httpReqs = summary.metrics?.http_reqs || {};
  const rate = numberOrNull(httpReqs.rate) ?? 0;
  const errorRate = numberOrNull(failed.value) ?? 0;
  return {
    id: `met_${crypto.randomUUID()}`,
    p50Ms: numberOrNull(duration.med),
    p95Ms: numberOrNull(duration["p(95)"]),
    p99Ms: numberOrNull(duration["p(99)"]),
    errorRate,
    peakRps: rate,
    degradationStartRps: planType === "limit_finder" ? rate * 0.8 : null,
    successRate: 1 - errorRate,
    summaryWindow: "full_run",
  };
}

async function setPhase(phase) {
  await tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/phase`, {
    method: "POST",
    body: { lease_token: job.leaseToken, phase },
  });
}
async function setSubtask(phase, subtaskId) {
  await tempyrApi(`/internal/execution-jobs/${encodeURIComponent(runId)}/subtask`, {
    method: "POST",
    body: { lease_token: job.leaseToken, phase, subtask_id: subtaskId },
  });
}

async function tempyrApi(path, { method = "GET", body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${executionToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`Tempyr Runner API returned non-JSON (${response.status})`); }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Tempyr Runner API failed with HTTP ${response.status}`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function normalizeFlows(flows) {
  return flows.map((flowEntry) => ({
    ...flowEntry,
    steps: (flowEntry.steps || []).map(normalizeStepBodyForBindings),
  }));
}
function normalizeStepBodyForBindings(step) {
  const bodyBindings = (step.bindings || []).filter((binding) =>
    binding?.consumerLocation === "body" && binding.consumerSelector !== "" && binding.consumerSelector !== "/"
  );
  if (!bodyBindings.length) return step;
  const execution = step.execution && typeof step.execution === "object" ? step.execution : {};
  if (typeof execution.body !== "string") return step;
  let parsed;
  try { parsed = JSON.parse(execution.body); }
  catch { throw new Error(`Cannot apply body binding for ${step.name || execution.path || "request"}: request body must be valid JSON.`); }
  if (parsed === null || typeof parsed !== "object") throw new Error(`Cannot apply body binding for ${step.name || execution.path || "request"}: request body must be a JSON object or array.`);
  return { ...step, execution: { ...execution, body: parsed } };
}

function validationMetricThresholds(scenarios) {
  const entries = [];
  const stepIds = new Set();
  const tagIds = new Set();
  for (const scenario of scenarios || []) {
    for (const flow of scenario.flows || []) {
      for (const step of flow.steps || []) {
        if (step.type === "wait") continue;
        const execution = step.execution && typeof step.execution === "object" ? step.execution : {};
        const stepId = safeMetricTag(step.id || step.name || execution.path || "step");
        stepIds.add(stepId);
        const tags = (Array.isArray(step.tags) ? step.tags : []).map((tag) => safeMetricTag(tag?.id)).filter(Boolean);
        if (tags.length) tags.forEach((tagId) => tagIds.add(tagId));
        else tagIds.add("__untagged__");
      }
    }
  }
  for (const stepId of stepIds) {
    entries.push(`${JSON.stringify(`http_req_duration{pt_step_id:${stepId}}`)}: [{ threshold: "p(95)<999999999", abortOnFail: false }]`);
    entries.push(`${JSON.stringify(`http_req_failed{pt_step_id:${stepId}}`)}: [{ threshold: "rate<1.01", abortOnFail: false }]`);
    entries.push(`${JSON.stringify(`http_reqs{pt_step_id:${stepId}}`)}: [{ threshold: "count>=0", abortOnFail: false }]`);
  }
  for (const tagId of tagIds) {
    entries.push(`${JSON.stringify(`pt_tag_duration{pt_tag_id:${tagId}}`)}: [{ threshold: "p(95)<999999999", abortOnFail: false }]`);
    entries.push(`${JSON.stringify(`pt_tag_failed{pt_tag_id:${tagId}}`)}: [{ threshold: "rate<1.01", abortOnFail: false }]`);
    entries.push(`${JSON.stringify(`pt_tag_requests{pt_tag_id:${tagId}}`)}: [{ threshold: "count>=0", abortOnFail: false }]`);
  }
  return entries.join(",\n    ");
}
function safeMetricTag(value) { return String(value ?? "").replace(/[{},:]/g, "_").slice(0, 160); }
function executionTimeoutMs(plan) {
  const seconds = Number(plan.guardrail?.maxDurationSec || 300);
  return Number.isFinite(seconds) && seconds > 0 ? (seconds + 10) * 1000 : 310_000;
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function normalizeApiBase(value) {
  const raw = String(value || "").replace(/\/+$/, "");
  if (!raw) throw new Error("TEMPYR_API_BASE is required");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function safeMessage(error) { return String(error?.message || "External k6 runner failed").slice(0, 1000); }

async function writeStepSummary(result, plan) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [
    `## Tempyr run ${runId}`,
    "",
    `- Status: **${result.status}**`,
    `- Test plan: ${plan.testPlan?.name || "Test Plan"}`,
    `- Summary: ${result.summary}`,
  ];
  if (result.metricSummary) {
    lines.push(`- p95: ${result.metricSummary.p95Ms ?? "n/a"} ms`);
    lines.push(`- Error rate: ${result.metricSummary.errorRate ?? "n/a"}`);
  }
  await writeFile(path, `${lines.join("\n")}\n`, { flag: "a" });
}
