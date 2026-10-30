#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeSummaryFocus } from "./defaults.mjs";
import { resolveGpuHousekeeperUrl } from "../../../../program/runtime/gpu/managed-ollama.mjs";

const PROGRAM_DIR = path.dirname(new URL(import.meta.url).pathname);
const HOUSE = path.resolve(PROGRAM_DIR, "..");
const RESOLVED_OLLAMA_HOST = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
const GPU_HOUSEKEEPER_URL = resolveGpuHousekeeperUrl({
  ollamaUrl: RESOLVED_OLLAMA_HOST,
  env: process.env,
});

function usage() {
  process.stdout.write("Usage: node program/run-full-transcript-pipeline-from-meeting-folder.mjs <meeting_dir> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]\n");
}

function ensureDir(p, label) {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error(`${label} not found: ${p}`);
  }
}

function looksLikeInterview(meetingDir) {
  const meetingJson = path.join(meetingDir, "meeting.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(meetingJson, "utf8"));
    const payload = parsed?.payload || parsed || {};
    const text = [payload.meeting_name, payload.title, payload.description, payload.meeting_type]
      .map((value) => String(value || "")).join(" ");
    return /\b(?:interview|conversation\s+with|in\s+conversation|question(?:s)?\s+and\s+answer|q\s*[&+]\s*a)\b/iu.test(text);
  } catch {
    return false;
  }
}

function runWithStreaming({ cmd, args, cwd = HOUSE, env = {}, timeoutMs = 8 * 60 * 60 * 1000, label = "stage" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      stderr += text;
      process.stderr.write(text);
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
  const meetingDirArg = process.argv[2];
  const basePrefix = process.argv[3] || "meeting-qwen-auto";
  const focus = normalizeSummaryFocus(process.argv[4]);
  const jurisdiction = process.argv[5] || "Andrii Zvorygin";
  const body = process.argv[6] || "Livestream";
  const siteUrl = process.argv[7] || "https://andrii.zvorygin.ca";
  const discussionUrl = process.argv[8] || "";
  const speakerHostRaw = String(process.env.PYA_SPEAKER_HOST || "mriczo").trim();
  const speakerHost = /^https?:\/\//iu.test(speakerHostRaw)
    ? speakerHostRaw.replace(/\/+$/u, "")
    : `http://${speakerHostRaw.replace(/\/+$/u, "")}:8010`;

  if (!meetingDirArg) {
    usage();
    process.exit(2);
  }

  const meetingDir = path.resolve(process.cwd(), meetingDirArg);
  ensureDir(meetingDir, "meeting directory");
  const transcriptDir = path.join(meetingDir, "transcript");
  ensureDir(transcriptDir, "transcript directory");
  const interviewLike = looksLikeInterview(meetingDir);
  // Sentence-level attribution is mandatory for every meeting type. Do not
  // let legacy environment overrides re-enable aggregate turns.
  const sentenceLevelSpeakerTurns = true;
  const cueLevelSpeakerTurns = "1";
  const sameSpeakerThreshold = process.env.PYA_SPEAKER_SAME_THRESHOLD
    || (interviewLike ? "0.72" : "0.58");

  process.stdout.write(`[full-pipeline-meeting] meeting dir: ${meetingDir}\n`);
  process.stdout.write(`[full-pipeline-meeting] transcript dir: ${transcriptDir}\n`);

  process.stdout.write(`[llm] ollama host: ${RESOLVED_OLLAMA_HOST}\n`);
  process.stdout.write(`[gpu] housekeeper: ${GPU_HOUSEKEEPER_URL}\n`);

  await runWithStreaming({
    cmd: "node",
    args: [
      path.join(HOUSE, "program/run-full-transcript-pipeline.mjs"),
      transcriptDir,
      basePrefix,
      focus,
      jurisdiction,
      body,
      siteUrl,
      discussionUrl,
    ],
    cwd: HOUSE,
    env: {
      OLLAMA_HOST: RESOLVED_OLLAMA_HOST,
      PYA_GPU_HOUSEKEEPER_URL: GPU_HOUSEKEEPER_URL,
      PYA_SPEAKER_HOST: speakerHost,
      // Keep the expected-speaker hint for the voice service, but never turn
      // sentence cues into aggregate turns.  Mixed moderator/guest blocks are
      // precisely what this pipeline is designed to avoid.
      PYA_SPEAKER_EXPECTED_MAX: process.env.PYA_SPEAKER_EXPECTED_MAX || (interviewLike ? "2" : "0"),
      // Legacy aggregate relabel/reassign variables are intentionally absent.
      PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS: cueLevelSpeakerTurns,
      PYA_SPEAKER_CUE_LEVEL_TURNS: cueLevelSpeakerTurns,
      PYA_SPEAKER_SENTENCE_ONLY: process.env.PYA_SPEAKER_SENTENCE_ONLY || (sentenceLevelSpeakerTurns ? "1" : "0"),
      PYA_SPEAKER_BAD_SAMPLE_GUARD: "1",
      PYA_SPEAKER_BOUNDARY_REFINE: process.env.PYA_SPEAKER_BOUNDARY_REFINE || "0",
      PYA_SPEAKER_NAME_LINKING: process.env.PYA_SPEAKER_NAME_LINKING || "",
      PYA_SPEAKER_SAME_THRESHOLD: sameSpeakerThreshold,
    },
    timeoutMs: 8 * 60 * 60 * 1000,
    label: "full-pipeline",
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
