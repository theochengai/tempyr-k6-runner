export function renderTestPlanK6Script({
  environment,
  scenarios = [],
  guardrail = {}
}) {
  if (!scenarios.length) throw new Error("At least one Scenario is required to render a Test Plan");

  const targetMap = normalizeTargetMap(environment);
  const authHeaderEnvKeys = Object.fromEntries((environment.authValues?.headers || []).map((item) => [item.name, variableEnvKey("auth-header", item.name)]));
  const authCookieEnvKeys = Object.fromEntries((environment.authValues?.cookies || []).map((item) => [item.name, variableEnvKey("auth-cookie", item.name)]));
  const hasDatasets = scenarios.some((entry) => (entry.datasets || []).length);
  const datasetImports = hasDatasets ? '\nimport exec from "k6/execution";\nimport { SharedArray } from "k6/data";' : "";
  const optionEntries = scenarios.map((entry, scenarioIndex) => {
    const key = scenarioKey(entry, scenarioIndex);
    return `${JSON.stringify(key)}: ${JSON.stringify({
      ...renderWorkload(entry.workload.executor, entry.workload.config || {}),
      exec: `scenario_${scenarioIndex}`
    }, null, 2)}`;
  }).join(",\n    ");
  const thresholdEntries = scenarios.flatMap((entry, scenarioIndex) => {
    const key = scenarioKey(entry, scenarioIndex);
    const thresholds = entry.workload?.config?.thresholds || { p95Ms: 3000, errorRate: 0.05 };
    return [
      `${JSON.stringify(`http_req_failed{scenario:${key}}`)}: [{ threshold: "rate<${thresholds.errorRate ?? 0.05}", abortOnFail: true, delayAbortEval: "2s" }]`,
      `${JSON.stringify(`http_req_duration{scenario:${key}}`)}: [{ threshold: "p(95)<${thresholds.p95Ms ?? 3000}", abortOnFail: true, delayAbortEval: "2s" }]`,
      ...stepMetricThresholds(entry),
      ...tagMetricThresholds(entry)
    ];
  }).join(",\n    ");
  const datasetDefinitions = scenarios.flatMap((entry, scenarioIndex) =>
    (entry.datasets || []).map((dataset, datasetIndex) =>
      `const DATASET_${scenarioIndex}_${datasetIndex} = new SharedArray(${JSON.stringify(`${entry.scenario?.name || `Scenario ${scenarioIndex + 1}`} · ${dataset.fileName}`)}, () => JSON.parse(open(${JSON.stringify(dataset.dataFile)})));`
    )
  ).join("\n");
  const environmentVariableDefinitions = [
    ...Object.keys(environment.variables || {}).map((name) => ({ runtimeName: `env.${name}`, envKey: variableEnvKey("env", name) })),
    ...Object.keys(environment.secrets || {}).map((name) => ({ runtimeName: `secret.${name}`, envKey: variableEnvKey("secret", name) }))
  ];
  const initialEnvironmentVars = environmentVariableDefinitions
    .map(({ runtimeName, envKey }) => `${JSON.stringify(runtimeName)}: parseEnvValue(__ENV[${JSON.stringify(envKey)}])`)
    .join(",\n  ");
  const initialVariableDefinitions = scenarios.map((entry, scenarioIndex) => {
    const entries = (entry.variableNames || [])
      .map((name) => `${JSON.stringify(name)}: parseEnvValue(__ENV[${JSON.stringify(variableEnvKey(`scenario-${scenarioIndex}`, name))}])`)
      .join(",\n  ");
    return `const INITIAL_VARS_${scenarioIndex} = {\n  ${entries}\n};`;
  }).join("\n");
  const scenarioFunctions = scenarios.map((entry, scenarioIndex) => renderScenarioFunction(entry, scenarioIndex)).join("\n\n");
  const flowFunctions = scenarios.flatMap((entry, scenarioIndex) =>
    (entry.flows || []).map((flow, flowIndex) => renderFlowFunction(flow, scenarioIndex, flowIndex, guardrail))
  ).join("\n\n");
  const defaultExport = `export default function () {\n  scenario_0();\n}`;
  const datasetHelper = hasDatasets ? `
function selectDatasetRow(dataset, strategy, datasetName) {
  const index = strategy === "per_iteration"
    ? exec.scenario.iterationInTest
    : exec.vu.idInTest - 1;
  if (!Number.isInteger(index) || index < 0 || index >= dataset.length) {
    throw new Error("DATASET_EXHAUSTED: " + datasetName + " has " + dataset.length + " rows but row " + (index + 1) + " was requested by " + strategy);
  }
  return dataset[index];
}
` : "";

  return `
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";${datasetImports}

const PT_TAG_DURATION = new Trend("pt_tag_duration", true);
const PT_TAG_REQUESTS = new Counter("pt_tag_requests");
const PT_TAG_FAILED = new Rate("pt_tag_failed");
const TARGETS = ${JSON.stringify(targetMap, null, 2)};
const AUTH_HEADER_ENV_KEYS = ${JSON.stringify(authHeaderEnvKeys, null, 2)};
const AUTH_COOKIE_ENV_KEYS = ${JSON.stringify(authCookieEnvKeys, null, 2)};
const INITIAL_ENV_VARS = {
  ${initialEnvironmentVars}
};
${initialVariableDefinitions}
${datasetDefinitions ? `\n${datasetDefinitions}\n` : ""}
export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    ${optionEntries}
  },
  thresholds: {
    ${thresholdEntries}
  }
};

${scenarioFunctions}

${defaultExport}

${flowFunctions}

function recordTagMetrics(response, passed, tagIds) {
  const duration = Number(response?.timings?.duration ?? 0);
  for (const tagId of tagIds) {
    const tags = { pt_tag_id: tagId };
    PT_TAG_DURATION.add(Number.isFinite(duration) ? duration : 0, tags);
    PT_TAG_REQUESTS.add(1, tags);
    PT_TAG_FAILED.add(!passed, tags);
  }
}

function parseEnvValue(value) {
  if (value === undefined || value === null || value === "") return value ?? "";
  try { return JSON.parse(value); } catch { return value; }
}

function resolveValue(value, vars) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, vars)]));
  if (typeof value !== "string") return value;
  const exact = value.match(/^\\{\\{([A-Za-z0-9_.-]+)\\}\\}$/);
  if (exact) return Object.prototype.hasOwnProperty.call(vars, exact[1]) ? vars[exact[1]] : value;
  return value.replace(/\\{\\{([A-Za-z0-9_.-]+)\\}\\}/g, (match, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

function targetBase(targetKey) {
  const key = String(targetKey || "primary");
  const base = TARGETS[key];
  if (!base) throw new Error("ENVIRONMENT_TARGET_MISSING: " + key);
  return base;
}

function environmentAuthHeaders() {
  const headers = {};
  for (const [name, envKey] of Object.entries(AUTH_HEADER_ENV_KEYS)) {
    const value = __ENV[envKey];
    if (value !== undefined && value !== "") headers[name] = parseEnvValue(value);
  }
  const pairs = [];
  for (const [name, envKey] of Object.entries(AUTH_COOKIE_ENV_KEYS)) {
    const value = __ENV[envKey];
    if (value !== undefined && value !== "") pairs.push(name + "=" + parseEnvValue(value));
  }
  if (pairs.length) headers.Cookie = pairs.join("; ");
  return headers;
}

function mergeRequestHeaders(requestHeaders) {
  const auth = environmentAuthHeaders();
  const result = { ...(requestHeaders || {}), ...auth };
  if (requestHeaders?.Cookie && auth.Cookie) result.Cookie = requestHeaders.Cookie + "; " + auth.Cookie;
  return result;
}

function buildUrl(baseUrl, path, query, vars) {
  const resolvedPath = String(resolveValue(path, vars));
  const resolvedQuery = resolveValue(query || {}, vars);
  const parts = [];
  for (const [key, value] of Object.entries(resolvedQuery)) {
    if (Array.isArray(value)) value.forEach((item) => parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(item))));
    else if (value !== undefined && value !== null) parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  if (!parts.length) return baseUrl + resolvedPath;
  return baseUrl + resolvedPath + (resolvedPath.includes("?") ? "&" : "?") + parts.join("&");
}

function readJsonPath(root, selector) {
  if (!selector || selector === "$") return root;
  const tokens = [];
  String(selector).replace(/\\.([A-Za-z_$][\\w$]*)|\\[(\\d+)\\]|\\["([^"]+)"\\]/g, (_match, property, index, quoted) => {
    tokens.push(property ?? quoted ?? Number(index));
    return _match;
  });
  let value = root;
  for (const token of tokens) {
    if (value === undefined || value === null) return undefined;
    value = value[token];
  }
  return value;
}

function responseHeader(response, name) {
  const expected = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(response.headers || {})) if (key.toLowerCase() === expected) return value;
  return undefined;
}

function responseCookie(response, name) {
  const values = response.cookies?.[name];
  return Array.isArray(values) && values.length ? values[0]?.value : undefined;
}
${datasetHelper}
`;
}

export function renderScenarioK6Script({ environment, scenario, workload, flows = [], guardrail = {}, variableNames = [], datasets = [] }) {
  return renderTestPlanK6Script({ environment, guardrail, scenarios: [{ scenario, workload, flows, variableNames, datasets }] });
}

export function buildTestPlanVariableEnvironment(scenarios = [], environment = {}) {
  const result = {};
  for (const [name, value] of Object.entries(environment.variables || {})) result[variableEnvKey("env", name)] = JSON.stringify(value);
  for (const [name, value] of Object.entries(environment.secrets || {})) result[variableEnvKey("secret", name)] = JSON.stringify(value);
  for (const item of environment.authValues?.headers || []) result[variableEnvKey("auth-header", item.name)] = JSON.stringify(item.value);
  for (const item of environment.authValues?.cookies || []) result[variableEnvKey("auth-cookie", item.name)] = JSON.stringify(item.value);
  scenarios.forEach((entry, scenarioIndex) => {
    for (const [name, value] of Object.entries(entry.variables || {})) result[variableEnvKey(`scenario-${scenarioIndex}`, name)] = JSON.stringify(value);
  });
  return result;
}

export function buildScenarioVariableEnvironment(variables = {}, environment = {}) {
  return buildTestPlanVariableEnvironment([{ variables }], environment);
}

export function resolveScenarioInitialTemplates(value, variables = {}) {
  if (Array.isArray(value)) return value.map((item) => resolveScenarioInitialTemplates(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveScenarioInitialTemplates(item, variables)]));
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{([A-Za-z0-9_.-]+)\}\}$/);
  if (exact && Object.prototype.hasOwnProperty.call(variables, exact[1])) return variables[exact[1]];
  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, name) => Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match);
}

function renderScenarioFunction(entry, scenarioIndex) {
  const datasetInitializers = (entry.datasets || []).map((dataset, datasetIndex) => {
    const assignments = (dataset.variables || []).map((variable) => `    vars[${JSON.stringify(variable.variableKey)}] = datasetRow_${scenarioIndex}_${datasetIndex}[${JSON.stringify(variable.columnName)}];`).join("\n");
    return `\n  const datasetRow_${scenarioIndex}_${datasetIndex} = selectDatasetRow(DATASET_${scenarioIndex}_${datasetIndex}, ${JSON.stringify(dataset.selectionStrategy)}, ${JSON.stringify(dataset.fileName)});\n${assignments}`;
  }).join("\n");
  const flowCalls = (entry.flows || []).map((_flow, flowIndex) => `  flow_${scenarioIndex}_${flowIndex}(vars);`).join("\n");
  return `export function scenario_${scenarioIndex}() {\n  const vars = { ...INITIAL_ENV_VARS, ...INITIAL_VARS_${scenarioIndex} };${datasetInitializers}\n${flowCalls}\n}`;
}

function renderFlowFunction(entry, scenarioIndex, flowIndex, guardrail) {
  const flowName = entry.flow?.name || entry.name || `Flow ${flowIndex + 1}`;
  const stepLines = (entry.steps || []).map((step) => renderStep(step, guardrail, { flow: entry.flow, flowIndex })).join("\n");
  return `function flow_${scenarioIndex}_${flowIndex}(vars) {\n  group(${JSON.stringify(flowName)}, () => {\n${indent(stepLines, 4)}\n  });\n}`;
}

function renderStep(step, guardrail, context = {}) {
  const rawExecution = step.execution && typeof step.execution === "object" ? step.execution : {};
  const execution = applyBindingsToExecution(rawExecution, step.bindings || []);
  const timing = step.timing && typeof step.timing === "object" ? step.timing : {};
  const validation = step.validation && typeof step.validation === "object" ? step.validation : {};
  if (step.type === "wait") {
    const thinkTimeMs = Number(timing.thinkTimeMs ?? timing.think_time_ms ?? 0);
    const seconds = Number(execution.seconds ?? (thinkTimeMs > 0 ? thinkTimeMs / 1000 : 1));
    return `sleep(${Number.isFinite(seconds) && seconds >= 0 ? seconds : 1});`;
  }
  if (isSideEffectBlocked(step, guardrail)) return `throw new Error(${JSON.stringify(`SIDE_EFFECT_REPLAY_DENIED: ${step.name || execution.path}`)});`;

  const method = String(execution.method || "GET").toUpperCase();
  const headers = execution.headers && typeof execution.headers === "object" ? execution.headers : {};
  const query = execution.query && typeof execution.query === "object" ? execution.query : {};
  const path = execution.path || "/";
  const targetKey = String(execution.target || "primary");
  const urlExpression = `buildUrl(targetBase(${JSON.stringify(targetKey)}), ${JSON.stringify(path)}, ${JSON.stringify(query)}, vars)`;
  const expectedStatus = validation.expectedStatus ?? validation.expected_status;
  const expected = Number(expectedStatus);
  const hasExpectedStatus = expectedStatus !== undefined && expectedStatus !== null && Number.isFinite(expected);
  const checkLabel = hasExpectedStatus ? `${step.name} returned ${expected}` : `${step.name} returned success`;
  const checkExpression = hasExpectedStatus ? `r.status === ${expected}` : "r.status < 400";
  const timeoutMs = Number(timing.timeoutMs ?? timing.timeout_ms ?? 0);
  const thinkTimeMs = Number(timing.thinkTimeMs ?? timing.think_time_ms ?? 0);
  const timeoutLine = timeoutMs > 0 ? `, timeout: ${JSON.stringify(`${timeoutMs}ms`)}` : "";
  const tagsLine = `, tags: ${JSON.stringify(stepMetricTags(step, execution, context))}`;
  const tagMetricIds = JSON.stringify(stepTagMetricIds(step));
  const sleepLine = thinkTimeMs > 0 ? `\n    sleep(${thinkTimeMs / 1000});` : "";
  const extractionLines = renderExtractions(step.extraction);

  if (method === "GET") return `{
  const requestHeaders = mergeRequestHeaders(resolveValue(${JSON.stringify(headers)}, vars));
  const response = http.get(${urlExpression}, { headers: requestHeaders${timeoutLine}${tagsLine} });
  const passed = check(response, { ${JSON.stringify(checkLabel)}: (r) => ${checkExpression} });
  recordTagMetrics(response, passed, ${tagMetricIds});${extractionLines}${sleepLine}
}`;
  return `{
  const requestHeaders = mergeRequestHeaders({ "Content-Type": "application/json", ...resolveValue(${JSON.stringify(headers)}, vars) });
  const payload = resolveValue(${JSON.stringify(execution.body ?? {})}, vars);
  const requestBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const response = http.request(${JSON.stringify(method)}, ${urlExpression}, requestBody, { headers: requestHeaders${timeoutLine}${tagsLine} });
  const passed = check(response, { ${JSON.stringify(checkLabel)}: (r) => ${checkExpression} });
  recordTagMetrics(response, passed, ${tagMetricIds});${extractionLines}${sleepLine}
}`;
}

function stepMetricThresholds(entry) {
  return (entry.flows || []).flatMap((flowEntry) =>
    (flowEntry.steps || [])
      .filter((step) => step.type !== "wait")
      .flatMap((step) => {
        const execution = step.execution && typeof step.execution === "object" ? step.execution : {};
        const tags = stepMetricTags(step, execution, { flow: flowEntry.flow });
        return [
          `${JSON.stringify(`http_req_duration{pt_step_id:${tags.pt_step_id}}`)}: [{ threshold: "p(95)<999999999", abortOnFail: false }]`,
          `${JSON.stringify(`http_req_failed{pt_step_id:${tags.pt_step_id}}`)}: [{ threshold: "rate<1.01", abortOnFail: false }]`,
          `${JSON.stringify(`http_reqs{pt_step_id:${tags.pt_step_id}}`)}: [{ threshold: "count>=0", abortOnFail: false }]`
        ];
      })
  );
}

function tagMetricThresholds(entry) {
  const ids = new Set();
  for (const flowEntry of entry.flows || []) {
    for (const step of flowEntry.steps || []) {
      if (step.type === "wait") continue;
      for (const tagId of stepTagMetricIds(step)) ids.add(tagId);
    }
  }
  return [...ids].flatMap((tagId) => [
    `${JSON.stringify(`pt_tag_duration{pt_tag_id:${tagId}}`)}: [{ threshold: "p(95)<999999999", abortOnFail: false }]`,
    `${JSON.stringify(`pt_tag_failed{pt_tag_id:${tagId}}`)}: [{ threshold: "rate<1.01", abortOnFail: false }]`,
    `${JSON.stringify(`pt_tag_requests{pt_tag_id:${tagId}}`)}: [{ threshold: "count>=0", abortOnFail: false }]`
  ]);
}

function stepTagMetricIds(step) {
  const ids = [...new Set((Array.isArray(step.tags) ? step.tags : [])
    .map((tag) => safeMetricTag(tag?.id))
    .filter(Boolean))];
  return ids.length ? ids : ["__untagged__"];
}

function stepMetricTags(step, execution, context = {}) {
  return {
    pt_step_id: safeMetricTag(step.id || step.name || execution.path || "step"),
    pt_flow_id: safeMetricTag(context.flow?.id || `flow_${context.flowIndex ?? 0}`),
    pt_name: safeMetricTag(step.name || execution.path || "Request"),
    pt_method: safeMetricTag(String(execution.method || "GET").toUpperCase()),
    pt_path: safeMetricTag(execution.path || "/")
  };
}

function safeMetricTag(value) {
  return String(value ?? "")
    .replace(/[{},:]/g, "_")
    .slice(0, 160);
}

function renderExtractions(extraction) {
  const variables = Array.isArray(extraction?.variables) ? extraction.variables : [];
  if (!variables.length) return "";
  return variables.map((variable) => {
    if (variable.source === "response_body") return `\n  vars[${JSON.stringify(variable.name)}] = readJsonPath(response.json(), ${JSON.stringify(variable.selector)});`;
    if (variable.source === "response_header") return `\n  vars[${JSON.stringify(variable.name)}] = responseHeader(response, ${JSON.stringify(variable.selector)});`;
    if (variable.source === "response_cookie") return `\n  vars[${JSON.stringify(variable.name)}] = responseCookie(response, ${JSON.stringify(variable.selector)});`;
    return "";
  }).join("");
}

function applyBindingsToExecution(rawExecution, bindings) {
  const execution = structuredCloneSafe(rawExecution);
  for (const binding of bindings || []) {
    if (!binding?.runtimeKey || !binding?.consumerLocation) continue;
    const template = binding.consumerTemplate || `{{${binding.runtimeKey}}}`;
    if (binding.consumerLocation === "header") execution.headers = { ...(execution.headers || {}), [binding.consumerSelector]: template };
    else if (binding.consumerLocation === "query") execution.query = { ...(execution.query || {}), [binding.consumerSelector]: template };
    else if (binding.consumerLocation === "body") execution.body = setJsonPointer(execution.body, binding.consumerSelector, template);
    else if (binding.consumerLocation === "path") execution.path = replacePathSegment(execution.path || "/", binding.consumerSelector, template);
    else if (binding.consumerLocation === "cookie") {
      execution.headers = { ...(execution.headers || {}) };
      execution.headers.Cookie = replaceCookie(execution.headers.Cookie || "", binding.consumerSelector, template);
    }
  }
  return execution;
}

function setJsonPointer(root, pointer, replacement) {
  if (pointer === "/" || pointer === "") return replacement;
  const parts = String(pointer).split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  const copy = structuredCloneSafe(root);
  let current = copy;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (current === null || current === undefined) return copy;
    current = current[parts[index]];
  }
  if (current !== null && current !== undefined) current[parts.at(-1)] = replacement;
  return copy;
}

function replacePathSegment(path, selector, replacement) {
  const targetIndex = Number(selector);
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return path;
  const parts = String(path || "/").split("/");
  const indexes = [];
  parts.forEach((part, index) => { if (part) indexes.push(index); });
  const actualIndex = indexes[targetIndex];
  if (actualIndex === undefined) return path;
  parts[actualIndex] = replacement;
  return parts.join("/") || "/";
}

function replaceCookie(header, name, replacement) {
  const pairs = String(header || "").split(";").map((item) => item.trim()).filter(Boolean);
  let found = false;
  const next = pairs.map((pair) => {
    const separator = pair.indexOf("=");
    const key = separator >= 0 ? pair.slice(0, separator).trim() : pair;
    if (key !== name) return pair;
    found = true;
    return `${name}=${replacement}`;
  });
  if (!found) next.push(`${name}=${replacement}`);
  return next.join("; ");
}

function renderWorkload(executor, config) {
  const normalized = normalizeWorkloadConfig(config);
  const scenario = { executor };
  for (const [key, value] of Object.entries(normalized)) if (key !== "thresholds" && value !== undefined && value !== null) scenario[key] = value;
  return scenario;
}

function normalizeWorkloadConfig(config) {
  const aliases = { time_unit: "timeUnit", start_vus: "startVUs", start_rate: "startRate", pre_allocated_vus: "preAllocatedVUs", max_vus: "maxVUs", max_duration: "maxDuration" };
  return Object.fromEntries(Object.entries(config || {}).map(([key, value]) => [aliases[key] || key, value]));
}

function isSideEffectBlocked(step, guardrail) {
  if (!guardrail?.denySideEffectReplay) return false;
  const deniedPaths = Array.isArray(guardrail.deniedPaths) ? guardrail.deniedPaths : [];
  const execution = step.execution && typeof step.execution === "object" ? step.execution : {};
  const safety = step.safety && typeof step.safety === "object" ? step.safety : {};
  return Boolean(safety.hasSideEffect) || deniedPaths.some((deniedPath) => String(execution.path || "").startsWith(deniedPath));
}

function variableEnvKey(scope, name) {
  const safeScope = String(scope || "global").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const safe = String(name || "value").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 48) || "VALUE";
  const suffix = deterministicHash(`${scope}:${String(name)}`);
  return `PERF_VAR_${safeScope}_${safe}_${suffix}`;
}

function deterministicHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").toUpperCase();
}

function scenarioKey(entry, index) {
  const raw = entry.scenario?.id || entry.scenario?.name || `scenario_${index + 1}`;
  return String(raw).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || `scenario_${index + 1}`;
}

function normalizeTargetMap(environment) {
  const raw = environment.targetMap && typeof environment.targetMap === "object" ? environment.targetMap : Object.fromEntries((environment.targets || []).map((target) => [target.key, target.url]));
  const result = {};
  for (const [key, value] of Object.entries(raw || {})) result[key] = stripTrailingSlash(String(value));
  if (!result.primary && environment.baseUrl) result.primary = stripTrailingSlash(environment.baseUrl);
  if (!result.primary) throw new Error("Primary Environment target is required");
  return result;
}

function stripTrailingSlash(value) { return value.endsWith("/") ? value.slice(0, -1) : value; }
function structuredCloneSafe(value) { if (typeof structuredClone === "function") return structuredClone(value); return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function indent(value, spaces) { const prefix = " ".repeat(spaces); return String(value || "").split("\n").map((line) => `${prefix}${line}`).join("\n"); }
