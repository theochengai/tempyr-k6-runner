import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const RUN_TIME_SERIES_SCHEMA_VERSION = 1;
export const RUN_TIME_SERIES_BUCKET_MS = 5000;
export const RUN_TIME_SERIES_MAX_BYTES = 512 * 1024;

const API_METRICS = new Set(["http_reqs", "http_req_failed", "http_req_duration"]);
const TAG_METRICS = new Set(["pt_tag_requests", "pt_tag_failed", "pt_tag_duration"]);
const UNTAGGED_METRIC_ID = "__untagged__";

export async function normalizeK6JsonOutput({
  inputPath,
  runId,
  startedAt,
  endedAt,
  bucketMs = RUN_TIME_SERIES_BUCKET_MS,
}) {
  if (!inputPath) throw new Error("inputPath is required");
  const accumulator = createRunTimeSeriesAccumulator({ runId, startedAt, endedAt, bucketMs });
  const input = createReadStream(inputPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let malformedLines = 0;

  for await (const line of lines) {
    const value = String(line || "").trim();
    if (!value) continue;
    try {
      addK6TimeSeriesSample(accumulator, JSON.parse(value));
    } catch {
      malformedLines += 1;
    }
  }

  const normalized = finalizeRunTimeSeriesAccumulator(accumulator);
  const text = JSON.stringify(normalized.artifact);
  const sizeBytes = new TextEncoder().encode(text).byteLength;
  if (sizeBytes > RUN_TIME_SERIES_MAX_BYTES) {
    const error = new Error(`Time-series artifact exceeds ${RUN_TIME_SERIES_MAX_BYTES} bytes`);
    error.code = "RUN_TIME_SERIES_TOO_LARGE";
    error.sizeBytes = sizeBytes;
    throw error;
  }

  return {
    artifact: normalized.artifact,
    diagnostics: {
      ...normalized.diagnostics,
      malformedLines,
      sizeBytes,
    },
  };
}

export function createRunTimeSeriesAccumulator({
  runId,
  startedAt,
  endedAt,
  bucketMs = RUN_TIME_SERIES_BUCKET_MS,
}) {
  if (!runId) throw new Error("runId is required");
  const startMs = timestampMs(startedAt, "startedAt");
  const endMs = timestampMs(endedAt, "endedAt");
  if (endMs < startMs) throw new Error("endedAt must not be before startedAt");
  if (!Number.isInteger(bucketMs) || bucketMs <= 0) throw new Error("bucketMs must be a positive integer");

  return {
    runId,
    startMs,
    endMs,
    bucketMs,
    apiGroups: new Map(),
    tagGroups: new Map(),
    diagnostics: {
      ignoredSamples: 0,
      identityConflicts: 0,
    },
  };
}

export function addK6TimeSeriesSample(accumulator, sample) {
  if (!accumulator || !sample || sample.type !== "Point") return;
  const metricKind = API_METRICS.has(sample.metric)
    ? "api"
    : TAG_METRICS.has(sample.metric)
      ? "tag"
      : null;
  if (!metricKind) return;

  const data = sample.data || {};
  const tags = data.tags || {};
  const identity = metricKind === "api" ? apiIdentity(tags) : tagIdentity(tags);
  if (!identity) {
    accumulator.diagnostics.ignoredSamples += 1;
    return;
  }
  const sampleMs = Date.parse(data.time);
  const value = Number(data.value);
  if (
    !Number.isFinite(sampleMs)
    || !Number.isFinite(value)
    || sampleMs < accumulator.startMs
    || sampleMs >= accumulator.endMs
  ) {
    accumulator.diagnostics.ignoredSamples += 1;
    return;
  }

  const groups = metricKind === "api" ? accumulator.apiGroups : accumulator.tagGroups;
  const identityKey = metricKind === "api" ? identity.stepId : identity.metricTagId;
  let group = groups.get(identityKey);
  if (!group) {
    group = { identity, buckets: new Map() };
    groups.set(identityKey, group);
  } else if (!(metricKind === "api" ? sameApiIdentity(group.identity, identity) : sameTagIdentity(group.identity, identity))) {
    accumulator.diagnostics.identityConflicts += 1;
    return;
  }

  const bucketIndex = Math.floor((sampleMs - accumulator.startMs) / accumulator.bucketMs);
  const bucketStartMs = accumulator.startMs + bucketIndex * accumulator.bucketMs;
  let bucket = group.buckets.get(bucketStartMs);
  if (!bucket) {
    bucket = { requests: 0, failed: 0, durations: [] };
    group.buckets.set(bucketStartMs, bucket);
  }

  if (sample.metric === "http_reqs" || sample.metric === "pt_tag_requests") bucket.requests += value;
  else if (sample.metric === "http_req_failed" || sample.metric === "pt_tag_failed") bucket.failed += value;
  else if (sample.metric === "http_req_duration" || sample.metric === "pt_tag_duration") bucket.durations.push(value);
}

export function finalizeRunTimeSeriesAccumulator(accumulator) {
  if (!accumulator) throw new Error("accumulator is required");
  const { runId, startMs, endMs, bucketMs, apiGroups, tagGroups, diagnostics } = accumulator;

  const apis = [...apiGroups.values()]
    .sort((a, b) => compareApiIdentity(a.identity, b.identity))
    .map(({ identity, buckets }) => ({
      ...identity,
      points: finalizeBuckets(buckets, { bucketMs, endMs }),
    }));

  const tags = [...tagGroups.values()]
    .sort((a, b) => compareTagIdentity(a.identity, b.identity))
    .map(({ identity, buckets }) => ({
      tagId: identity.tagId,
      name: identity.name,
      points: finalizeBuckets(buckets, { bucketMs, endMs }),
    }));

  return {
    artifact: {
      schemaVersion: RUN_TIME_SERIES_SCHEMA_VERSION,
      runId,
      bucketMs,
      executionWindow: {
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
      },
      apis,
      tags,
    },
    diagnostics: { ...diagnostics },
  };
}

function apiIdentity(tags) {
  const stepId = clean(tags?.pt_step_id);
  const method = clean(tags?.pt_method).toUpperCase();
  const path = clean(tags?.pt_path);
  if (!stepId || !method || !path) return null;
  return {
    stepId,
    flowId: clean(tags?.pt_flow_id) || null,
    name: clean(tags?.pt_name) || path,
    method,
    path,
  };
}

function tagIdentity(tags) {
  const metricTagId = clean(tags?.pt_tag_id);
  if (!metricTagId) return null;
  const untagged = metricTagId === UNTAGGED_METRIC_ID;
  return {
    metricTagId,
    tagId: untagged ? null : metricTagId,
    name: clean(tags?.pt_tag_name) || (untagged ? "Untagged" : metricTagId),
  };
}

function finalizeBuckets(buckets, { bucketMs, endMs }) {
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStartMs, bucket]) => {
      const bucketEndMs = Math.min(bucketStartMs + bucketMs, endMs);
      const actualDurationMs = Math.max(1, bucketEndMs - bucketStartMs);
      const requests = finiteCount(bucket.requests);
      return {
        timestamp: new Date(bucketStartMs).toISOString(),
        requests,
        rps: requests / (actualDurationMs / 1000),
        p95Ms: bucket.durations.length ? percentile(bucket.durations, 0.95) : null,
        p99Ms: bucket.durations.length ? percentile(bucket.durations, 0.99) : null,
        errorRate: requests > 0 ? clamp(bucket.failed / requests, 0, 1) : null,
      };
    });
}

function percentile(values, quantile) {
  const sorted = (values || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const q = clamp(Number(quantile), 0, 1);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function sameApiIdentity(a, b) {
  return a.stepId === b.stepId
    && a.flowId === b.flowId
    && a.name === b.name
    && a.method === b.method
    && a.path === b.path;
}

function sameTagIdentity(a, b) {
  return a.metricTagId === b.metricTagId && a.tagId === b.tagId && a.name === b.name;
}

function compareApiIdentity(a, b) {
  return String(a.flowId || "").localeCompare(String(b.flowId || ""))
    || a.stepId.localeCompare(b.stepId);
}

function compareTagIdentity(a, b) {
  if (a.tagId === null && b.tagId !== null) return 1;
  if (a.tagId !== null && b.tagId === null) return -1;
  return a.name.localeCompare(b.name) || a.metricTagId.localeCompare(b.metricTagId);
}

function timestampMs(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clean(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
