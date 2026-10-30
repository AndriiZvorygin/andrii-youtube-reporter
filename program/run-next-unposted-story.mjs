#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ANDRII_ADAPTER } from "./writer-adapter-andrii-youtube.mjs";
import { buildRunNextConfig } from "./shared-writer-adapter-interface.mjs";
import { applyPublishEnvNormalization } from "../../../../program/publisher-interface.mjs";
import { normalizeSummaryFocus } from "./defaults.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYASH_ROOT = path.resolve(PROGRAM_DIR, "../../../..");

function runWithStreaming({ cmd, args, cwd, env = {}, timeoutMs = 8 * 60 * 60 * 1000, label = "stage" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const t = String(chunk || "");
      stdout += t;
      process.stdout.write(t);
    });
    child.stderr.on("data", (chunk) => {
      const t = String(chunk || "");
      stderr += t;
      process.stderr.write(t);
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(10_000, Number(timeoutMs) || 10_000));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label} failed (code=${code ?? "null"} signal=${signal ?? ""})\n${stderr || stdout}`.trim()));
    });
  });
}

async function main() {
  const basePrefix = process.argv[2] || ANDRII_ADAPTER.defaults.base_prefix;
  const focus = normalizeSummaryFocus(process.argv[3] || ANDRII_ADAPTER.defaults.focus);
  const jurisdiction = process.argv[4] || ANDRII_ADAPTER.defaults.jurisdiction;
  const body = process.argv[5] || ANDRII_ADAPTER.defaults.body;
  const siteUrl = process.argv[6] || ANDRII_ADAPTER.defaults.site_url;
  const discussionUrl = process.argv[7] || ANDRII_ADAPTER.defaults.discussion_url;
  const execMxid = process.argv[8] || process.env.ANDRII_EXEC_MXID || ANDRII_ADAPTER.defaults.exec_mxid;

  const cfg = buildRunNextConfig(ANDRII_ADAPTER, {
    basePrefix,
    focus,
    jurisdiction,
    body,
    siteUrl,
    discussionUrl,
    execMxid,
    timezone: ANDRII_ADAPTER.defaults.timezone,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "andrii-next-story-"));
  const cfgPath = path.join(tempDir, "config.json");
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

  const normalized = applyPublishEnvNormalization({
    env: process.env,
    adapter: ANDRII_ADAPTER,
    fallbackCommand: "",
  });
  const publishCommand = `node ${path.join(PROGRAM_DIR, "publish-meeting-to-andrii-from-payload.mjs")}`;
  const runEnv = {
    ...normalized.env,
    ANDRII_AUTOPUBLISH: normalized.env.ANDRII_AUTOPUBLISH || "1",
    ANDRII_LEMMY_POST_COMMAND: normalized.env.ANDRII_LEMMY_POST_COMMAND || normalized.env.MEETING_POST_COMMAND || publishCommand,
    MEETING_POST_COMMAND: normalized.env.MEETING_POST_COMMAND || normalized.env.ANDRII_LEMMY_POST_COMMAND || publishCommand,
  };

  await runWithStreaming({
    cmd: "node",
    args: [path.join(PYASH_ROOT, "command/run_next_unposted_story.mjs"), cfgPath],
    cwd: PYASH_ROOT,
    env: runEnv,
    timeoutMs: 8 * 60 * 60 * 1000,
    label: "run-next-unposted-story",
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
