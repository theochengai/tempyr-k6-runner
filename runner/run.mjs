#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = String(process.env.PERF_TARGET_URL || "").trim();
if (!target) throw new Error("PERF_TARGET_URL is required");

let parsed;
try {
  parsed = new URL(target);
} catch {
  throw new Error("PERF_TARGET_URL must be a valid URL");
}
if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
  throw new Error("PERF_TARGET_URL must use http or https");
}

const workdir = await mkdtemp(join(tmpdir(), "perftest-k6-"));
const scriptPath = join(workdir, "smoke.js");

const script = `
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 1,
  duration: "10s",
  thresholds: {
    http_req_failed: ["rate<0.05"]
  }
};

export default function () {
  const response = http.get(__ENV.TARGET_URL, {
    tags: { source: "perftest-k6-runner-smoke" }
  });
  check(response, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300
  });
  sleep(1);
}
`;

try {
  await writeFile(scriptPath, script, "utf8");
  const exitCode = await runK6(scriptPath, target);
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(workdir, { recursive: true, force: true });
}

function runK6(scriptPath, targetUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn("k6", ["run", "-e", `TARGET_URL=${targetUrl}`, scriptPath], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`k6 terminated by signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
