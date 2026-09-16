import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  engineArtifactHash,
  materializeK6EngineArtifact,
  resolveK6RuntimeEnvironment,
  validateK6EngineArtifact,
} from "../runner/engine-artifact.mjs";

test("materializes a verified k6 EngineArtifact and resolves late-bound runtime values", async () => {
  const artifact = fixtureArtifact();
  artifact.artifactHash = engineArtifactHash(artifact);
  const runtimeEnvironment = {
    variables: { region: "west" },
    secrets: { api_token: "secret-value" },
    authValues: {
      headers: [{ name: "Authorization", value: "Bearer token" }],
      cookies: [{ name: "session", value: "cookie-value" }],
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "tempyr-engine-artifact-"));
  try {
    const prepared = await materializeK6EngineArtifact({ artifact, runtimeEnvironment, artifactDir: dir });
    assert.equal(await readFile(join(dir, "script.js"), "utf8"), "export const options = {};\nexport default function () {}\n");
    assert.equal(await readFile(join(dir, "data/users.json"), "utf8"), "[{\"id\":1}]");
    assert.equal(prepared.timeoutMs, 12000);
    assert.deepEqual(prepared.runtimeEnv, {
      PERF_VAR_ENV_REGION_AAAA0001: '"west"',
      PERF_VAR_SECRET_API_TOKEN_AAAA0002: '"secret-value"',
      PERF_VAR_AUTH_HEADER_AUTHORIZATION_AAAA0003: '"Bearer token"',
      PERF_VAR_AUTH_COOKIE_SESSION_AAAA0004: '"cookie-value"',
      PERF_VAR_SCENARIO_0_SEED_AAAA0005: '"fixture"',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects artifact content that no longer matches its hash", () => {
  const artifact = fixtureArtifact();
  artifact.artifactHash = engineArtifactHash(artifact);
  artifact.files[0].content += "// tampered\n";
  assert.throws(() => validateK6EngineArtifact(artifact), /hash does not match/);
});

test("rejects unsafe artifact paths before materialization", () => {
  const artifact = fixtureArtifact();
  artifact.files.push({ path: "../escape.txt", content: "nope" });
  artifact.artifactHash = "sha256:" + "0".repeat(64);
  assert.throws(() => validateK6EngineArtifact(artifact), /Unsafe EngineArtifact file path/);
});

test("runtime binding resolution never reads values from the artifact itself", () => {
  const artifact = fixtureArtifact();
  artifact.artifactHash = engineArtifactHash(artifact);
  const runtime = resolveK6RuntimeEnvironment(artifact, {
    variables: { region: "live-region" },
    secrets: { api_token: "live-secret" },
    authValues: { headers: [], cookies: [] },
  });
  assert.equal(runtime.PERF_VAR_ENV_REGION_AAAA0001, '"live-region"');
  assert.equal(runtime.PERF_VAR_SECRET_API_TOKEN_AAAA0002, '"live-secret"');
  assert.equal(runtime.PERF_VAR_SCENARIO_0_SEED_AAAA0005, '"fixture"');
  assert.equal(runtime.PERF_VAR_AUTH_HEADER_AUTHORIZATION_AAAA0003, undefined);
});

function fixtureArtifact() {
  return {
    schemaVersion: 1,
    engine: "k6",
    compilerVersion: 1,
    entrypoint: "script.js",
    files: [
      {
        path: "script.js",
        contentType: "application/javascript; charset=utf-8",
        content: "export const options = {};\nexport default function () {}\n",
      },
      {
        path: "data/users.json",
        contentType: "application/json; charset=utf-8",
        content: "[{\"id\":1}]",
      },
    ],
    manifest: {
      executionMode: "full",
      summaryTrendStats: ["avg", "p(95)"],
      timeoutMs: 12000,
      runtimeBindings: [
        { envKey: "PERF_VAR_ENV_REGION_AAAA0001", source: "environment_variable", name: "region" },
        { envKey: "PERF_VAR_SECRET_API_TOKEN_AAAA0002", source: "environment_secret", name: "api_token" },
        { envKey: "PERF_VAR_AUTH_HEADER_AUTHORIZATION_AAAA0003", source: "auth_header", name: "Authorization" },
        { envKey: "PERF_VAR_AUTH_COOKIE_SESSION_AAAA0004", source: "auth_cookie", name: "session" },
        { envKey: "PERF_VAR_SCENARIO_0_SEED_AAAA0005", source: "scenario_variable", scenarioIndex: 0, name: "seed", literal: '"fixture"' },
      ],
      testPlan: { id: "plan_1", name: "Fixture", planType: "perf_guard" },
      scenarioCount: 1,
    },
  };
}
