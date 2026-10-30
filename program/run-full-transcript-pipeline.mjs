#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeSummaryFocus } from "./defaults.mjs";
import {
  chapterTextStartsAtZero,
  findAuthoritativeChapterFile,
  normalizeChapterTextFile,
} from "./chapter-timestamps.mjs";
import { coverageReportPass } from "./candidate-answer-coverage.mjs";
import {
  namedSpeakerIdentityEnabled,
  speakerArtifactUsesDefaultLabels,
} from "../../../../program/library/reporter_shared/speaker-diarization-policy.mjs";
import { resolveGpuHousekeeperUrl } from "../../../../program/runtime/gpu/managed-ollama.mjs";

const PROGRAM_DIR = path.dirname(new URL(import.meta.url).pathname);
const HOUSE = path.resolve(PROGRAM_DIR, "..");
const ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const RESOLVED_OLLAMA_HOST = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
const GPU_HOUSEKEEPER_URL = resolveGpuHousekeeperUrl({
  ollamaUrl: RESOLVED_OLLAMA_HOST,
  env: process.env,
});

function usage() {
  process.stdout.write("Usage: node program/run-full-transcript-pipeline.mjs <transcript_dir> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]\n");
}

function existsFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function fileFresh(target, source) {
  if (!source) return true;
  if (!existsFile(target) || !existsFile(source)) return false;
  try { return fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs; } catch { return false; }
}

function envFlag(name, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function speakerRosterDigest(value) {
  const raw = String(value || "").trim();
  const titleCase = (text) => String(text || "").split(/\s+/u).map((token) => token
    ? `${token.slice(0, 1).toLocaleUpperCase()}${token.slice(1).toLocaleLowerCase()}` : token).join(" ");
  const canonical = raw.split(/[;\n|]+/u).map((item) => String(item || "").trim()).filter(Boolean).map((item) => {
    const comma = item.match(/^([^,]+),\s*(.+)$/u);
    return titleCase(comma ? `${comma[2]} ${comma[1]}` : item);
  }).filter(Boolean).join("; ");
  const moderator = String(process.env.PYA_SPEAKER_MODERATOR_NAME || "").trim();
  const withModerator = moderator && canonical
    ? `${canonical}; ${moderator}`
    : (canonical || moderator);
  return [raw, canonical, withModerator].filter(Boolean).map((text) => crypto.createHash("sha256").update(text, "utf8").digest("hex"));
}

function configuredRosterNames(value = process.env.PYA_SPEAKER_NAME_ROSTER || "") {
  const titleCase = (text) => String(text || "").split(/\s+/u).map((token) => token
    ? `${token.slice(0, 1).toLocaleUpperCase()}${token.slice(1).toLocaleLowerCase()}` : token).join(" ");
  return String(value || "").split(/[;\n|]+/u).map((item) => String(item || "").trim()).filter(Boolean).map((item) => {
    const comma = item.match(/^([^,]+),\s*(.+)$/u);
    return titleCase(comma ? `${comma[2]} ${comma[1]}` : item);
  }).filter(Boolean);
}

function looksLikeInterview(transcriptDir) {
  const meetingJson = path.join(transcriptDir, "..", "meeting.json");
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

function normalizationCheckpointHealthy(outputPath) {
  if (!existsFile(outputPath) || fs.statSync(outputPath).size < 1) return false;
  const metadataPath = outputPath.replace(/\.plain\.txt$/u, ".normalize.metadata.json");
  if (!existsFile(metadataPath)) return false;
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    return metadata?.coverage_pass === true
      && Number(metadata?.chunks_processed || 0) === Number(metadata?.chunks_total || 0)
      && Number(metadata?.coverage_ratio || 0) >= 0.8;
  } catch {
    return false;
  }
}

function chapterSummaryCheckpointHealthy(summaryPya, summaryMd, verifyPya, groundingPya, speakerRoster = "") {
  if (![summaryPya, summaryMd, verifyPya, groundingPya].every(existsFile)) return false;
  try {
    const marker = fs.readFileSync(verifyPya, "utf8");
    if (!/su name pass be bool true ya/u.test(marker)) return false;
    const sections = Number(marker.match(/su name sections be num\s+([0-9]+)/u)?.[1] || 0);
    if (sections < 1) return false;
    const rosterDigest = marker.match(/su name speaker roster sha256 be text "([a-f0-9]{64})" ya/iu)?.[1] || "";
    if (speakerRoster && (!rosterDigest || !speakerRosterDigest(speakerRoster).includes(rosterDigest))) return false;
    const markerTime = fs.statSync(verifyPya).mtimeMs;
    return markerTime >= fs.statSync(summaryPya).mtimeMs
      && markerTime >= fs.statSync(summaryMd).mtimeMs
      && markerTime >= fs.statSync(groundingPya).mtimeMs;
  } catch {
    return false;
  }
}

function questionBoundariesCheckpointFresh(boundariesPath, downstreamPath) {
  if (!existsFile(boundariesPath)) return false;
  if (!existsFile(downstreamPath)) return false;
  try { return fs.statSync(downstreamPath).mtimeMs >= fs.statSync(boundariesPath).mtimeMs; } catch { return false; }
}

function speakerNameMapCheckpointHealthy(mapPath, markerPath, speakerJsonPath) {
  if (![mapPath, markerPath, speakerJsonPath].every(existsFile)) return false;
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    if (Number(map?.schema_version || 0) !== 1 || !Array.isArray(map?.spans) || map.spans.length < 1 || !Array.isArray(map?.aliases)) return false;
    const configured = configuredRosterNames();
    if (configured.length && !configured.every((name) => map.roster?.some((person) => String(person?.canonical_name || "").toLocaleLowerCase() === name.toLocaleLowerCase()))) return false;
    const moderator = String(process.env.PYA_SPEAKER_MODERATOR_NAME || "").trim();
    if (moderator && !map.roster?.some((person) => person?.role === "moderator" && String(person?.canonical_name || "").toLocaleLowerCase() === moderator.toLocaleLowerCase())) return false;
    const source = crypto.createHash("sha256").update(fs.readFileSync(speakerJsonPath)).digest("hex");
    return String(map?.source_sha256 || "") === source
      && /su name pass be bool true ya/u.test(fs.readFileSync(markerPath, "utf8"))
      && fs.statSync(markerPath).mtimeMs >= fs.statSync(mapPath).mtimeMs
      && fs.statSync(mapPath).mtimeMs >= fs.statSync(speakerJsonPath).mtimeMs;
  } catch {
    return false;
  }
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function runWithStreaming({ cmd, args, cwd = ROOT, env = {}, timeoutMs = 8 * 60 * 60 * 1000, label = "stage" }) {
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
  const transcriptDirArg = process.argv[2];
  const basePrefix = process.argv[3] || "meeting-qwen-auto";
  const focus = normalizeSummaryFocus(process.argv[4]);
  if (!transcriptDirArg) {
    usage();
    process.exit(2);
  }

  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = RESOLVED_OLLAMA_HOST;
if (!process.env.PYA_GPU_HOUSEKEEPER_URL) process.env.PYA_GPU_HOUSEKEEPER_URL = GPU_HOUSEKEEPER_URL;
process.stdout.write(`[llm] ollama host: ${RESOLVED_OLLAMA_HOST}\n`);
process.stdout.write(`[gpu] housekeeper: ${GPU_HOUSEKEEPER_URL}\n`);
  if (!fs.existsSync(transcriptDir)) throw new Error(`transcript directory not found: ${transcriptDir}`);

  const normPrefix = `${basePrefix}-normalized`;
  const forcePostTranscribe = envFlag("PYA_NORMALIZE_FORCE")
    || envFlag("PYA_FULL_PIPELINE_FORCE")
    || envFlag("ANDRII_PIPELINE_FORCE");
  // Allow fixes to chapter segmentation/summarisation to be applied to an
  // existing healthy transcript without needlessly retranscribing it.  This
  // is intentionally downstream-only: source transcription and normalization
  // checkpoints remain authoritative unless their own force switch is set.
  const forceChapterStages = envFlag("PYA_CHAPTER_FORCE");
  // Rebuild only the audio diarization/name-link stages when their policy
  // changes. This avoids retranscribing a healthy source while ensuring the
  // sentence-level speaker output and all evidence maps are regenerated.
  const forceSpeakerStages = envFlag("PYA_SPEAKER_FORCE") || envFlag("PYA_DIARIZATION_FORCE");
  const answerChapterMode = envFlag("PYA_ANSWER_CHAPTER_MODE");
  const questionMode = envFlag("PYA_CHAPTER_QUESTION_MODE") || answerChapterMode;
  const interviewLike = looksLikeInterview(transcriptDir);
  const namedSpeakerIdentity = namedSpeakerIdentityEnabled(process.env);
  // The diarizer is sentence-level for every source. Aggregate turn
  // relabeling is unsafe around moderator/candidate handoffs and is no longer
  // an allowed pipeline mode.
  const sentenceLevelSpeakerTurns = true;
  const speakerHostRaw = String(process.env.PYA_SPEAKER_HOST || "mriczo").trim();
  const speakerHost = /^https?:\/\//iu.test(speakerHostRaw)
    ? speakerHostRaw.replace(/\/+$/u, "")
    : `http://${speakerHostRaw.replace(/\/+$/u, "")}:8010`;
  const artifacts = {
    timingSrt: path.join(transcriptDir, `${basePrefix}.timing.srt`),
    plainTxt: path.join(transcriptDir, `${basePrefix}.plain.txt`),
    mergedSrt: path.join(transcriptDir, `${basePrefix}.merged.srt`),
    normPlain: path.join(transcriptDir, `${normPrefix}.plain.txt`),
    sentenceSrt: path.join(transcriptDir, `${normPrefix}.sentences.merged.srt`),
    speakerSrt: path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentence.srt`),
    speakerJson: path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentences.json`),
    speakerNameMap: path.join(transcriptDir, `${normPrefix}.speaker-name-map.json`),
    speakerNameMapMarker: path.join(transcriptDir, `${normPrefix}.speaker-name-map.pya`),
    questionBoundaries: path.join(transcriptDir, `${normPrefix}.question-boundaries.json`),
    candidateAnswerChapters: path.join(transcriptDir, `${normPrefix}.candidate-answer-chapters.json`),
    candidateAnswerCoverage: path.join(transcriptDir, `${normPrefix}.candidate-answer-coverage.json`),
    chapterGross: path.join(transcriptDir, `${normPrefix}.chapter.gross-chunks.pya`),
    chapterGrounding: path.join(transcriptDir, `${normPrefix}.chapter.grounding.pya`),
    chapterSummaryPya: path.join(transcriptDir, `${normPrefix}.chapter-summary.pya`),
    chapterSummaryMd: path.join(transcriptDir, `${normPrefix}.chapter-summary.md`),
    chapterSummaryVerify: path.join(transcriptDir, `${normPrefix}.chapter-summary.verify.pya`),
    meetingSummaryChunks: path.join(transcriptDir, `${normPrefix}.meeting-summary.chunks.pya`),
    meetingSummaryPya: path.join(transcriptDir, `${normPrefix}.meeting-summary.pya`),
    meetingSummaryMd: path.join(transcriptDir, `${normPrefix}.meeting-summary.md`),
    chaptersTxt: path.join(transcriptDir, `${normPrefix}.chapters.txt`),
    reportPya: path.join(transcriptDir, `${normPrefix}.full-pipeline.report.pya`),
  };
  const authoritativeChaptersPath = findAuthoritativeChapterFile(transcriptDir, normPrefix);

  const stageStatus = [];
  async function stage(name, fn, skipWhen) {
    if (skipWhen && skipWhen()) {
      stageStatus.push({ stage: name, status: "skipped", reason: "checkpoint exists" });
      process.stdout.write(`[full-pipeline] skip ${name} (checkpoint exists)\n`);
      return;
    }
    const started = Date.now();
    process.stdout.write(`[full-pipeline] start ${name}\n`);
    try {
      await fn();
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      stageStatus.push({ stage: name, status: "ok", seconds: Number(seconds) });
      process.stdout.write(`[full-pipeline] done ${name} in ${seconds}s\n`);
    } catch (err) {
      stageStatus.push({ stage: name, status: "error", error: String(err?.message || err) });
      throw err;
    }
  }

  // Repair chapter-description checkpoints created before the YouTube
  // 00:00 contract was enforced. This is a formatting-only migration: it
  // does not invalidate transcript, grounding, or summary checkpoints.
  if (existsFile(artifacts.chaptersTxt)) {
    const changed = normalizeChapterTextFile(artifacts.chaptersTxt);
    if (changed) process.stdout.write(`[full-pipeline] normalized first chapter marker in ${artifacts.chaptersTxt}\n`);
  }

  await stage("transcribe+merge", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(ROOT, "world/house/owen-sound-reporter/program/transcribe-and-merge-qwen-from-transcript-folder.mjs"), transcriptDir, basePrefix],
      cwd: ROOT,
      env: {
        OLLAMA_HOST: process.env.OLLAMA_HOST || "http://mriczo:11434",
        PYA_HEAR_QWEN_HOST: process.env.PYA_HEAR_QWEN_HOST || "",
        PYA_DRAW_HOST: process.env.PYA_DRAW_HOST || "",
        PYA_HEAR_TIMEOUT_MS: process.env.PYA_HEAR_TIMEOUT_MS || String(45 * 60 * 1000),
        QWEN_HEAR_STAGE_ATTEMPTS: process.env.QWEN_HEAR_STAGE_ATTEMPTS || "2",
      },
      timeoutMs: 6 * 60 * 60 * 1000,
      label: "transcribe+merge",
    });
  }, () => existsFile(artifacts.timingSrt) && existsFile(artifacts.plainTxt) && existsFile(artifacts.mergedSrt));

  let normalizationRebuilt = false;
  await stage("normalize-transcript", async () => {
    normalizationRebuilt = true;
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/normalize-transcript-from-transcript-folder.mjs"), transcriptDir, basePrefix, normPrefix],
      cwd: ROOT,
      env: { OLLAMA_HOST: process.env.OLLAMA_HOST || "http://mriczo:11434" },
      timeoutMs: 4 * 60 * 60 * 1000,
      label: "normalize-transcript",
    });
  }, () => !forcePostTranscribe && normalizationCheckpointHealthy(artifacts.normPlain));

  await stage("sentence-cues", async () => {
    try {
      await runWithStreaming({
        cmd: "node",
        args: [path.join(ROOT, "command/lyrics_to_srt_from_timing.mjs"), artifacts.normPlain, artifacts.timingSrt, artifacts.sentenceSrt, "--sentence-cues"],
        cwd: ROOT,
        label: "lyrics-to-srt-from-timing",
      });
    } catch {
      await runWithStreaming({
        cmd: "node",
        args: [path.join(ROOT, "command/lyrics_to_srt_even.mjs"), artifacts.normPlain, path.join(transcriptDir, "meeting-audio.opus"), artifacts.sentenceSrt],
        cwd: ROOT,
        label: "lyrics-to-srt-even",
      });
    }
  }, () => !forcePostTranscribe && !normalizationRebuilt && existsFile(artifacts.sentenceSrt));

  await stage("diarize-speakers", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(ROOT, "command/diarize_sentence_srt_from_transcript_folder.mjs"), transcriptDir, `${normPrefix}.sentences`, path.join(ROOT, "world/voices")],
      cwd: ROOT,
      env: {
        PYA_SPEAKER_ISOLATE_VOICES: process.env.PYA_SPEAKER_ISOLATE_VOICES || "1",
        PYA_SPEAKER_BOUNDARY_REFINE: process.env.PYA_SPEAKER_BOUNDARY_REFINE || "0",
        OLLAMA_HOST: process.env.OLLAMA_HOST || "http://mriczo:11434",
        PYA_SPEAKER_HOST: speakerHost,
        PYA_SPEAKER_EXPECTED_MAX: process.env.PYA_SPEAKER_EXPECTED_MAX || (interviewLike ? "2" : "0"),
        PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS: "1",
        PYA_SPEAKER_CUE_LEVEL_TURNS: "1",
        PYA_SPEAKER_SAME_THRESHOLD: process.env.PYA_SPEAKER_SAME_THRESHOLD || "0.58",
        PYA_SPEAKER_BAD_SAMPLE_GUARD: process.env.PYA_SPEAKER_BAD_SAMPLE_GUARD || "1",
      },
      timeoutMs: 4 * 60 * 60 * 1000,
      label: "diarize-speakers",
    });
  }, () => !forcePostTranscribe && !forceSpeakerStages && !normalizationRebuilt
    && existsFile(artifacts.speakerSrt)
    && existsFile(artifacts.speakerJson)
    && (namedSpeakerIdentity
      || (speakerArtifactUsesDefaultLabels(artifacts.speakerJson)
        && speakerArtifactUsesDefaultLabels(artifacts.speakerSrt))));

  await stage("link-speaker-names", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/link-panel-speakers-from-transcript-folder.mjs"), transcriptDir, normPrefix],
      cwd: ROOT,
      timeoutMs: 3 * 60 * 60 * 1000,
      label: "link-speaker-names",
    });
  }, () => !envFlag("PYA_SPEAKER_NAME_LINKING")
    || (!forcePostTranscribe && !forceSpeakerStages && !normalizationRebuilt && speakerNameMapCheckpointHealthy(
      artifacts.speakerNameMap,
      artifacts.speakerNameMapMarker,
      artifacts.speakerJson,
    )));

  await stage("question-boundaries", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/identify-question-boundaries-from-transcript-folder.mjs"), transcriptDir, normPrefix],
      cwd: ROOT,
      timeoutMs: 3 * 60 * 60 * 1000,
      label: "question-boundaries",
    });
  }, () => !questionMode || (!forceChapterStages && existsFile(artifacts.questionBoundaries)));

  await stage("candidate-answer-chapters", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/segment-candidate-answers-from-transcript-folder.mjs"), transcriptDir, normPrefix],
      cwd: ROOT,
      timeoutMs: 4 * 60 * 60 * 1000,
      label: "candidate-answer-chapters",
    });
  }, () => !answerChapterMode || (!forceChapterStages
    && existsFile(artifacts.candidateAnswerChapters)
    && coverageReportPass(artifacts.candidateAnswerCoverage)
    && fileFresh(artifacts.candidateAnswerCoverage, artifacts.candidateAnswerChapters)
    && fileFresh(artifacts.candidateAnswerChapters, artifacts.questionBoundaries)
    && fileFresh(artifacts.candidateAnswerChapters, artifacts.speakerNameMap)));

  await stage("chapter-gross", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/chapter-gross-from-transcript-folder.mjs"), transcriptDir, normPrefix],
      cwd: ROOT,
      timeoutMs: 2 * 60 * 60 * 1000,
      label: "chapter-gross",
    });
  }, () => !forcePostTranscribe && !forceChapterStages && !normalizationRebuilt && existsFile(artifacts.chapterGross)
    && fileFresh(artifacts.chapterGross, authoritativeChaptersPath)
    && (!questionMode || questionBoundariesCheckpointFresh(artifacts.questionBoundaries, artifacts.chapterGross)));

  await stage("chapter-grounding", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/chapter-ground-from-transcript-folder.mjs"), transcriptDir, normPrefix],
      cwd: ROOT,
      label: "chapter-grounding",
    });
  }, () => !forcePostTranscribe
    && !forceChapterStages
    && !normalizationRebuilt
    && existsFile(artifacts.chapterGrounding)
    && existsFile(artifacts.chaptersTxt)
    && fileFresh(artifacts.chapterGrounding, artifacts.chapterGross)
    && chapterTextStartsAtZero(fs.readFileSync(artifacts.chaptersTxt, "utf8"))
    && fileFresh(artifacts.chaptersTxt, authoritativeChaptersPath)
    && (!questionMode || questionBoundariesCheckpointFresh(artifacts.questionBoundaries, artifacts.chapterGrounding)));

  await stage("chapter-summary", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/summarize-chapter-grounding-from-transcript-folder.mjs"), transcriptDir, normPrefix, focus],
      cwd: ROOT,
      timeoutMs: 2 * 60 * 60 * 1000,
      label: "chapter-summary",
    });
  }, () => !forcePostTranscribe && !forceChapterStages && !normalizationRebuilt && chapterSummaryCheckpointHealthy(artifacts.chapterSummaryPya, artifacts.chapterSummaryMd, artifacts.chapterSummaryVerify, artifacts.chapterGrounding, process.env.PYA_SPEAKER_NAME_ROSTER || "")
    && (!questionMode || questionBoundariesCheckpointFresh(artifacts.questionBoundaries, artifacts.chapterSummaryVerify)));

  await stage("whole-meeting-summary", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE, "program/summarize-whole-video-from-chapter-summary.mjs"), transcriptDir, normPrefix, focus],
      cwd: ROOT,
      timeoutMs: 2 * 60 * 60 * 1000,
      label: "whole-meeting-summary",
    });
  }, () => !forcePostTranscribe && !forceChapterStages && !normalizationRebuilt && existsFile(artifacts.meetingSummaryChunks) && existsFile(artifacts.meetingSummaryPya) && existsFile(artifacts.meetingSummaryMd)
    && fileFresh(artifacts.meetingSummaryMd, artifacts.chapterSummaryMd)
    && (!questionMode || questionBoundariesCheckpointFresh(artifacts.questionBoundaries, artifacts.meetingSummaryMd)));

  const reportLines = [
    "su name full pipeline report be map def",
    `su name transcript dir be text "${pyaEsc(transcriptDir)}" ya`,
    `su name norm prefix be text "${pyaEsc(normPrefix)}" ya`,
    `su name stage count be num ${stageStatus.length} ya`,
  ];
  for (let i = 0; i < stageStatus.length; i += 1) {
    const s = stageStatus[i];
    reportLines.push(`su name stage ${i + 1} be text "${pyaEsc(JSON.stringify(s))}" ya`);
  }
  reportLines.push("prah");
  fs.writeFileSync(artifacts.reportPya, `${reportLines.join("\n")}\n`, "utf8");
  process.stdout.write(`[full-pipeline] report: ${artifacts.reportPya}\n`);
  process.stdout.write("[full-pipeline] complete\n");
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
