import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export async function materializeK6EngineArtifact({ artifact, runtimeEnvironment = {}, artifactDir }) {
  validateK6EngineArtifact(artifact);
  if (!artifactDir) throw new Error("artifactDir is required");

  for (const file of artifact.files) {
    const relativePath = safeArtifactPath(file.path);
    const target = join(artifactDir, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }

  return {
    scriptPath: join(artifactDir, ...safeArtifactPath(artifact.entrypoint).split("/")),
    runtimeEnv: resolveK6RuntimeEnvironment(artifact, runtimeEnvironment),
    timeoutMs: positiveNumber(artifact.manifest?.timeoutMs, null),
    manifest: artifact.manifest || {},
  };
}

export function resolveK6RuntimeEnvironment(artifact, runtimeEnvironment = {}) {
  validateK6EngineArtifact(artifact);
  const result = {};
  for (const binding of artifact.manifest?.runtimeBindings || []) {
    const envKey = String(binding?.envKey || "");
    if (!envKey) throw new Error("EngineArtifact runtime binding is missing envKey");
    let encoded;
    if (binding.source === "environment_variable") {
      encoded = encodeRuntimeValue(runtimeEnvironment.variables?.[binding.name]);
    } else if (binding.source === "environment_secret") {
      encoded = encodeRuntimeValue(runtimeEnvironment.secrets?.[binding.name]);
    } else if (binding.source === "auth_header") {
      encoded = encodeRuntimeValue(namedRuntimeValue(runtimeEnvironment.authValues?.headers, binding.name));
    } else if (binding.source === "auth_cookie") {
      encoded = encodeRuntimeValue(namedRuntimeValue(runtimeEnvironment.authValues?.cookies, binding.name));
    } else if (binding.source === "scenario_variable") {
      encoded = binding.literal;
    } else {
      throw new Error(`Unsupported EngineArtifact runtime binding source ${binding.source}`);
    }
    if (encoded !== undefined) result[envKey] = String(encoded);
  }
  return result;
}

export function validateK6EngineArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") throw new Error("EngineArtifact is required");
  if (artifact.schemaVersion !== 1) throw new Error("Unsupported EngineArtifact schemaVersion");
  if (artifact.engine !== "k6") throw new Error(`Unsupported execution engine ${artifact.engine || "unknown"}`);
  if (!HASH_PATTERN.test(String(artifact.artifactHash || ""))) throw new Error("EngineArtifact hash is invalid");
  if (!artifact.entrypoint || typeof artifact.entrypoint !== "string") throw new Error("EngineArtifact entrypoint is required");
  if (!Array.isArray(artifact.files) || !artifact.files.length) throw new Error("EngineArtifact files are required");
  const paths = new Set();
  for (const file of artifact.files) {
    const path = safeArtifactPath(file?.path);
    if (paths.has(path)) throw new Error(`EngineArtifact contains duplicate file ${path}`);
    paths.add(path);
    if (typeof file?.content !== "string") throw new Error(`EngineArtifact file ${path} content must be a string`);
  }
  if (!paths.has(safeArtifactPath(artifact.entrypoint))) throw new Error("EngineArtifact entrypoint file is missing");
  const actualHash = engineArtifactHash(artifact);
  if (actualHash !== artifact.artifactHash) throw new Error("EngineArtifact hash does not match its contents");
  return artifact;
}

export function engineArtifactHash(artifact) {
  const { artifactHash: _artifactHash, ...input } = artifact || {};
  const digest = createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
  return `sha256:${digest}`;
}

function namedRuntimeValue(items, name) {
  const entry = (items || []).find((item) => item?.name === name);
  return entry?.value;
}

function encodeRuntimeValue(value) {
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

function safeArtifactPath(value) {
  const path = String(value || "").replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new Error("EngineArtifact file path must be relative");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe EngineArtifact file path ${path}`);
  return parts.join("/");
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
