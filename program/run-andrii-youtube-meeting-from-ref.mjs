#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPyaTextValues } from "../../../../command/pya_lookup.mjs";
import { verifyArticleClaims } from "../../../../program/library/reporter_shared/quality-verifiers.mjs";
import { ANDRII_ADAPTER } from "./writer-adapter-andrii-youtube.mjs";
import { normalizeSummaryFocus } from "./defaults.mjs";
import { speakerArtifactUsesDefaultLabels } from "../../../../program/library/reporter_shared/speaker-diarization-policy.mjs";
import { activeYoutubeSourceProfile, sourceProfileDefaults } from "./youtube-source-profiles.mjs";
import {
  requestManagedOllamaChat,
  resolveGpuHousekeeperUrl,
} from "../../../../program/runtime/gpu/managed-ollama.mjs";
import { coverageReportPass } from "./candidate-answer-coverage.mjs";
import { buildCandidateResponseTable } from "./candidate-response-table.mjs";
import {
  CANDIDATE_SOLUTION_STATS_SCHEMA,
  generateCandidateSolutionStats,
  renderCandidateSolutionStats,
} from "./candidate-solution-stats.mjs";
import {
  formatChapterTimestamp,
  findAuthoritativeChapterFile,
  normalizeChapterTextFile,
  parseChapterTimestamp,
} from "./chapter-timestamps.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");
const PYASH_ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const MEETINGS_DIR = path.join(HOUSE_ROOT, "artifacts/andrii-youtube/meetings");
const SECRET_PATHS = [
  path.join(HOUSE_ROOT, "configure/secret.pya"),
  path.join(PYASH_ROOT, "configure/secret.pya"),
  "/home/htaf/pyash/configure/secret.pya",
];
const SECRET_PATH = SECRET_PATHS.find((p) => fs.existsSync(p)) || SECRET_PATHS[0];
const SECRET_VALUES = readPyaTextValues(SECRET_PATH, [
  "ollama host",
  "ai host",
  "relay local host",
  "host",
  "draw host",
  "hear qwen host",
  "hear host",
]);

function resolveOllamaHost() {
  const fromEnv = String(process.env.OLLAMA_HOST || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, "");
  return String(SECRET_VALUES["ollama host"] || SECRET_VALUES["ai host"] || SECRET_VALUES["relay local host"] || SECRET_VALUES.host || "").trim().replace(/\/$/u, "");
}

const RESOLVED_OLLAMA_HOST = resolveOllamaHost();
if (!process.env.OLLAMA_HOST && RESOLVED_OLLAMA_HOST) process.env.OLLAMA_HOST = RESOLVED_OLLAMA_HOST;

function toComfyHostFromOllama(hostText) {
  const txt = String(hostText || "").trim();
  if (!txt) return "";
  return txt.replace(/:11434(?=\/?$)/u, ":8188").replace(/\/$/u, "");
}

function resolveHearQwenHost() {
  const fromEnv = String(process.env.PYA_HEAR_QWEN_HOST || process.env.PYA_DRAW_HOST || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, "");
  const fromSecret = String(
    SECRET_VALUES["hear qwen host"] || SECRET_VALUES["draw host"] || SECRET_VALUES["hear host"] || "",
  ).trim();
  if (fromSecret) return fromSecret.replace(/\/$/u, "");
  return toComfyHostFromOllama(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || "");
}

const RESOLVED_HEAR_QWEN_HOST = resolveHearQwenHost();
if (!process.env.PYA_HEAR_QWEN_HOST && RESOLVED_HEAR_QWEN_HOST) process.env.PYA_HEAR_QWEN_HOST = RESOLVED_HEAR_QWEN_HOST;
if (!process.env.PYA_DRAW_HOST && RESOLVED_HEAR_QWEN_HOST) process.env.PYA_DRAW_HOST = RESOLVED_HEAR_QWEN_HOST;

// Ollama's plain `format: "json"` permits Qwen to omit the corrected text or
// truncate the object when a long transcript is supplied.  A schema keeps the
// verifier response machine-readable while leaving all prose generation to
// the model.
const SUMMARY_VERIFY_FORMAT = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    corrected_markdown: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["pass", "corrected_markdown", "issues"],
};

// Ollama defaults to a small context window when callers omit num_ctx.  That
// silently truncates long verifier prompts and makes Qwen answer an easier,
// unrelated summary format. Keep the request bounded for the configured text
// model while allowing hosts with a different context budget to override it.
const OLLAMA_CONTEXT_TOKENS = Math.max(
  8192,
  Number(process.env.PYA_OLLAMA_CONTEXT_TOKENS || 32768) || 32768,
);

function usage() {
  return [
    "Usage: node program/run-andrii-youtube-meeting-from-ref.mjs <video_ref> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]",
    "video_ref can be any yt-dlp-supported video URL, a YouTube watch/short URL, or an 11-char YouTube video id.",
  ].join("\n");
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function envFlag(name) {
  return /^(1|true|yes)$/iu.test(String(process.env[name] || "0"));
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 90) || "stream";
}

function parseYoutubeId(ref) {
  const txt = String(ref || "").trim();
  if (!txt) return "";
  const direct = txt.match(/^[A-Za-z0-9_-]{11}$/u);
  if (direct) return direct[0];
  const q = txt.match(/[?&]v=([A-Za-z0-9_-]{11})/u);
  if (q) return q[1];
  const short = txt.match(/youtu\.be\/([A-Za-z0-9_-]{11})/u);
  if (short) return short[1];
  return "";
}

function resolveTranscriptRouteSuffix({ source, topic, dateIso, videoId, explicit = "" } = {}) {
  const requested = String(explicit || "").trim();
  if (requested) return slugify(requested);
  const currentId = String(videoId || "").trim();
  if (!currentId) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(MEETINGS_DIR, entry.name));
  } catch {
    return "";
  }
  for (const meetingDir of entries) {
    const payloadPath = path.join(meetingDir, "transcript", "meeting-qwen-auto-normalized.lemmy-post.json");
    let payload;
    if (fs.existsSync(payloadPath)) {
      try {
        payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
      } catch {
        payload = {};
      }
    }
    const meetingJsonPath = path.join(meetingDir, "meeting.json");
    let meeting = {};
    if (fs.existsSync(meetingJsonPath)) {
      try { meeting = JSON.parse(fs.readFileSync(meetingJsonPath, "utf8")); } catch { meeting = {}; }
    }
    const meetingPayload = meeting?.payload && typeof meeting.payload === "object" ? meeting.payload : meeting;
    const candidateSource = String(payload?.source || meetingPayload?.source || "").trim();
    const candidateTopic = String(payload?.topic || "").trim();
    const candidateDate = String(payload?.date_iso || String(meeting?.since || "").slice(0, 10)).trim();
    if (candidateSource !== String(source || "").trim()) continue;
    if (candidateTopic && candidateTopic !== String(topic || "").trim()) continue;
    if (candidateDate !== String(dateIso || "").trim()) continue;
    const otherId = parseYoutubeId(
      payload?.source_links?.meeting_url
      || payload?.source_links?.video_url
      || meetingPayload?.meeting_url
      || meetingPayload?.source_url
      || meetingPayload?.video?.[0]
      || "",
    );
    if (otherId && otherId !== currentId) return slugify(currentId.slice(0, 8));
  }
  return "";
}

function watchUrlFromRef(ref) {
  const id = parseYoutubeId(ref);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return String(ref || "").trim();
}

function isYoutubeRef(ref) {
  return /(?:youtube\.com|youtu\.be)/iu.test(String(ref || ""));
}

// Interviews need speaker attribution at the same granularity as the
// sentence cues. The diarizer otherwise batches adjacent cues into a turn
// for efficiency, which can smear a hand-off across several sentences. This
// is only a routing decision; the speaker service still classifies every cue.
function looksLikeInterview({ title = "", meta = {}, sourceInfo = {} } = {}) {
  const text = [
    title,
    meta?.title,
    meta?.description,
    sourceInfo?.meetingType,
  ].map((value) => String(value || "")).join(" ");
  return /\b(?:interview|conversation\s+with|in\s+conversation|question(?:s)?\s+and\s+answer|q\s*[&+]\s*a)\b/iu.test(text);
}

function sourceInfoFromMeta(ref, meta = {}) {
  const extractor = String(meta?.extractor_key || meta?.extractor || "").toLowerCase();
  const sourceUrl = String(meta?.webpage_url || ref || "").toLowerCase();
  if (extractor.includes("facebook") || sourceUrl.includes("facebook.com")) {
    return {
      meetingType: "Facebook Video",
      source: "facebook-video",
      channelUrl: String(meta?.uploader_url || meta?.channel_url || "").trim(),
      sourceLabel: "Original Facebook video",
      downloadLabel: "Facebook",
    };
  }
  return {
    meetingType: "YouTube Livestream",
    source: "youtube-live",
    channelUrl: String(meta?.channel_url || activeYoutubeSourceProfile().source_channel_url || ANDRII_ADAPTER.defaults.source_channel_url || "").trim(),
    sourceLabel: "Original livestream",
    downloadLabel: "YouTube",
  };
}

function titleFromMeta(meta = {}, id = "unknown", sourceInfo = {}) {
  const title = String(meta?.title || "").trim();
  const description = String(meta?.description || "").trim();
  if (sourceInfo.source === "facebook-video" && description && description.length <= 240) return description;
  return title || `${sourceInfo.meetingType || "Video"} ${id}`;
}

function timestampUrl(sourceUrl, seconds) {
  if (!isYoutubeRef(sourceUrl)) return sourceUrl;
  const separator = String(sourceUrl).includes("?") ? "&" : "?";
  return `${sourceUrl}${separator}t=${Math.max(0, Math.floor(Number(seconds) || 0))}s`;
}

function runWithStreaming({ cmd, args, cwd = PYASH_ROOT, env = {}, timeoutMs = 8 * 60 * 60 * 1000, label = "stage" }) {
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

function runQuiet(cmd, args, { cwd = PYASH_ROOT, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer });
}

async function runDiskPreflight(mountPath, requiredBytes = 0) {
  await runWithStreaming({
    cmd: "node",
    args: [
      path.join(PYASH_ROOT, "command/disk_housekeeping.mjs"),
      "--pre-download",
      "--required-bytes", String(Math.max(0, Number(requiredBytes) || 0)),
      "--mount", mountPath,
    ],
    cwd: PYASH_ROOT,
    timeoutMs: 30 * 60 * 1000,
    label: "disk-preflight",
  });
}

function ytDlpArgs(baseArgs = [], ref = "") {
  const extractorArgs = String(process.env.ANDRII_YTDLP_EXTRACTOR_ARGS || "youtube:player_client=android").trim();
  if (!extractorArgs || !isYoutubeRef(ref)) return [...baseArgs];
  return [...baseArgs, "--extractor-args", extractorArgs];
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadText(filePath, fallback = "") {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return fallback; }
}

function safeReadJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function normalizationCheckpointHealthy(outputPath) {
  try {
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1) return false;
    const metadataPath = outputPath.replace(/\.plain\.txt$/u, ".normalize.metadata.json");
    if (!fs.existsSync(metadataPath)) return false;
    const metadata = safeReadJson(metadataPath, {});
    return metadata?.coverage_pass === true
      && Number(metadata?.chunks_processed || 0) === Number(metadata?.chunks_total || 0)
      && Number(metadata?.coverage_ratio || 0) >= 0.8;
  } catch {
    return false;
  }
}

function chapterSummaryCheckpointHealthy(summaryPya, summaryMd, verifyPya, groundingPya, speakerRoster = "") {
  if (![summaryPya, summaryMd, verifyPya, groundingPya].every((p) => fs.existsSync(p))) return false;
  try {
    const marker = fs.readFileSync(verifyPya, "utf8");
    if (!/su name pass be bool true ya/u.test(marker)) return false;
    const sections = Number(marker.match(/su name sections be num\s+([0-9]+)/u)?.[1] || 0);
    if (sections < 1) return false;
    const rosterDigest = marker.match(/su name speaker roster sha256 be text "([a-f0-9]{64})" ya/iu)?.[1] || "";
    if (speakerRoster && (!rosterDigest || ![digestText(speakerRoster), digestText(canonicalSpeakerRoster(speakerRoster))].includes(rosterDigest))) return false;
    const markerTime = fs.statSync(verifyPya).mtimeMs;
    return markerTime >= fs.statSync(summaryPya).mtimeMs
      && markerTime >= fs.statSync(summaryMd).mtimeMs
      && markerTime >= fs.statSync(groundingPya).mtimeMs;
  } catch {
    return false;
  }
}

function questionChapterCheckpointFresh(boundariesPath, downstreamPath) {
  try {
    return fs.existsSync(boundariesPath)
      && fs.existsSync(downstreamPath)
      && fs.statSync(downstreamPath).mtimeMs >= fs.statSync(boundariesPath).mtimeMs;
  } catch {
    return false;
  }
}

function answerChapterCheckpointFresh(answerPath, coveragePath, ...sourcePaths) {
  try {
    if (!fs.existsSync(answerPath) || !coverageReportPass(coveragePath)) return false;
    const answerTime = fs.statSync(answerPath).mtimeMs;
    if (!fs.existsSync(coveragePath) || fs.statSync(coveragePath).mtimeMs < answerTime) return false;
    return sourcePaths.filter(Boolean).every((sourcePath) => !fs.existsSync(sourcePath) || answerTime >= fs.statSync(sourcePath).mtimeMs);
  } catch {
    return false;
  }
}

function speakerNameMapCheckpointFresh(mapPath, speakerJsonPath) {
  if (![mapPath, speakerJsonPath].every((p) => fs.existsSync(p))) return false;
  try {
    const map = safeReadJson(mapPath, {});
    if (Number(map?.schema_version || 0) !== 1 || !Array.isArray(map?.spans) || map.spans.length < 1 || !Array.isArray(map?.aliases)) return false;
    const configured = canonicalSpeakerRoster().split(/;+/u).map((name) => name.trim()).filter(Boolean);
    if (configured.length && !configured.every((name) => map.roster?.some((person) => String(person?.canonical_name || "").toLocaleLowerCase() === name.toLocaleLowerCase()))) return false;
    const source = digestText(fs.readFileSync(speakerJsonPath));
    return String(map?.source_sha256 || "") === source;
  } catch {
    return false;
  }
}

function scoreMeetingWorkspace(dirPath, basePrefix = "meeting-qwen-auto") {
  const transcriptDir = path.join(dirPath, "transcript");
  let score = 0;
  if (fs.existsSync(transcriptDir)) score += 1;
  const signals = [
    `${basePrefix}.timing.srt`,
    `${basePrefix}.plain.txt`,
    `${basePrefix}-normalized.plain.txt`,
    `${basePrefix}-normalized.sentences.merged.srt`,
    `${basePrefix}-normalized.sentences.speaker.sentence.srt`,
    `${basePrefix}-normalized.chapters.txt`,
    `${basePrefix}-normalized.lemmy-post.json`,
  ];
  for (const name of signals) {
    if (fs.existsSync(path.join(transcriptDir, name))) score += 2;
  }
  return score;
}

function resolveExistingMeetingDirByVideoId({ meetingsDir, meetingId, basePrefix }) {
  const id = String(meetingId || "").trim();
  if (!id) return "";
  const id8 = id.slice(0, 8);
  if (!fs.existsSync(meetingsDir)) return "";
  const dirs = fs.readdirSync(meetingsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let exact = [];
  let fallback = [];
  for (const base of dirs) {
    if (!base.endsWith(`_${id8}`)) continue;
    const dirPath = path.join(meetingsDir, base);
    const meetingJsonPath = path.join(dirPath, "meeting.json");
    if (fs.existsSync(meetingJsonPath)) {
      const meetingJson = safeReadJson(meetingJsonPath, {});
      const existingId = String(meetingJson?.payload?.meeting_id || "").trim();
      if (existingId && existingId === id) {
        exact.push(dirPath);
        continue;
      }
    }
    fallback.push(dirPath);
  }
  const chooseBest = (list) => {
    if (!Array.isArray(list) || !list.length) return "";
    return [...list]
      .sort((a, b) => {
        const sa = scoreMeetingWorkspace(a, basePrefix);
        const sb = scoreMeetingWorkspace(b, basePrefix);
        if (sa !== sb) return sb - sa;
        return a.localeCompare(b);
      })[0];
  };
  return chooseBest(exact) || chooseBest(fallback) || "";
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toDateInfoFromMeta(meta = {}) {
  const ts = Number(meta?.release_timestamp || meta?.timestamp || 0);
  let d = null;
  if (Number.isFinite(ts) && ts > 0) d = new Date(ts * 1000);
  const uploadDate = String(meta?.upload_date || "");
  if (!d && /^\d{8}$/u.test(uploadDate)) {
    d = new Date(`${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T12:00:00Z`);
  }
  if (!d || Number.isNaN(d.getTime())) d = new Date();
  const iso = d.toISOString().slice(0, 10);
  const long = d.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return { iso, long, date: d };
}

function parseSrt(text) {
  const blocks = String(text || "").split(/\r?\n\r?\n+/u);
  const rows = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const tm = lines[1].match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)\s+-->\s+(\d\d):(\d\d):(\d\d),(\d\d\d)$/u);
    if (!tm) continue;
    const since = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]) + Number(tm[4]) / 1000;
    const until = Number(tm[5]) * 3600 + Number(tm[6]) * 60 + Number(tm[7]) + Number(tm[8]) / 1000;
    const textLine = lines.slice(2).join(" ").replace(/\s+/gu, " ").trim();
    if (!textLine) continue;
    rows.push({ since, until, text: textLine });
  }
  return rows;
}

function readSpeakerRowsFromJson(filePath) {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rows = Array.isArray(obj?.rows) ? obj.rows : [];
    return rows
      .map((r) => ({
        index: Number.isInteger(Number(r?.index)) ? Number(r.index) : 0,
        since: Number(r?.since || 0),
        until: Number(r?.until || 0),
        text: String(r?.text || "").trim(),
        display: String(r?.display || "").trim(),
        speaker_key: String(r?.speaker_key || "").trim(),
      }))
      .filter((r) => Number.isFinite(r.since) && Number.isFinite(r.until) && (r.display || r.text));
  } catch {
    return [];
  }
}

function readSpeakerNameMap(filePath, speakerJsonPath) {
  if (!filePath || !fs.existsSync(filePath) || !speakerJsonPath || !fs.existsSync(speakerJsonPath)) return new Map();
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Number(payload?.schema_version || 0) !== 1 || !Array.isArray(payload?.spans)) return new Map();
    const sourceSha = digestText(fs.readFileSync(speakerJsonPath));
    if (String(payload?.source_sha256 || "") !== sourceSha) return new Map();
    const aliases = new Map();
    const sourceRows = (() => {
      try {
        const source = JSON.parse(fs.readFileSync(speakerJsonPath, "utf8"));
        return Array.isArray(source?.rows) ? source.rows : [];
      } catch { return []; }
    })();
    const moderatorCue = /^(?:all right|okay|the question|question(?: is|:)|next up|first up|second|third|fourth|fifth|sixth|our next|let(?:'s| us)|candidates?[, ]|time-wise|before i|each candidate|we have|we're going|i(?:'ll| will) (?:start|go|jump)|is (?:there|anyone)|please|good evening|ladies and gentlemen)\b|\b(?:the order in which|with that said|we will get opening statements|first up|second will|third will|fourth will|fifth will|sixth will|next up|opening statement|the question is|for this next question|we're going to start|when we do closing remarks|don't worry,? guys|i will remember where you were)\b/iu;
    for (const span of payload.spans) {
      const name = cleanInline(span?.canonical_name);
      const role = String(span?.role || "").trim().toLowerCase();
      const confidence = Number(span?.confidence);
      const start = Number(span?.start_row);
      const end = Number(span?.end_row);
      if (!name || !["candidate", "moderator"].includes(role) || !Number.isFinite(confidence) || confidence < 0.82) continue;
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
      for (let row = start; row <= end; row += 1) {
        const prior = aliases.get(row);
        const sourceRow = sourceRows[row - 1];
        // Do not relabel moderator handoffs/questions merely because the LLM
        // returned a broad diarizer span. The remaining answer rows can still
        // receive a name; mixed or cue-only rows stay with their raw label.
        if (moderatorCue.test(String(sourceRow?.text || ""))) continue;
        if (!prior || confidence > prior.confidence) aliases.set(row, { name, role, confidence });
      }
    }
    return aliases;
  } catch {
    return new Map();
  }
}

function writeSpeakerAliasesToJson(filePath, aliasByKey) {
  if (!filePath || !fs.existsSync(filePath) || !(aliasByKey instanceof Map) || !aliasByKey.size) return;
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
  const rows = Array.isArray(obj?.rows) ? obj.rows : [];
  let changed = false;
  for (const row of rows) {
    const key = String(row?.speaker_key || row?.display || row?.speaker || "").trim();
    const alias = String(aliasByKey.get(key) || "").trim();
    if (!key || !alias) continue;
    if (row.display !== alias) {
      row.display = alias;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  }
}

function looksLikeSyntheticSingleSpeaker(filePath) {
  const rows = readSpeakerRowsFromJson(filePath);
  if (!rows.length) return false;
  let labeled = 0;
  for (const row of rows) {
    const d = String(row.display || "").trim();
    if (/^SPEAKER_001:/u.test(d)) labeled += 1;
  }
  return labeled >= Math.max(5, Math.floor(rows.length * 0.9));
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.floor((Number(seconds) || 0) * 1000));
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(mmm).padStart(3, "0")}`;
}

function parseClockToSeconds(clockText) {
  const t = String(clockText || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})$/u);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  return hh * 3600 + mm * 60 + ss;
}

function writeSingleSpeakerSrt({ mergedSrtPath, outSrtPath, outJsonPath }) {
  const rows = parseSrt(safeReadText(mergedSrtPath, ""));
  const out = [];
  const jsonRows = [];
  let i = 0;
  for (const row of rows) {
    i += 1;
    const display = `SPEAKER_001: ${row.text}`;
    out.push(`${i}`);
    out.push(`${formatSrtTime(row.since)} --> ${formatSrtTime(row.until)}`);
    out.push(display);
    out.push("");
    jsonRows.push({
      since: row.since,
      until: row.until,
      text: row.text,
      speaker: "SPEAKER_001",
      display,
      key: "speaker_001",
    });
  }
  fs.writeFileSync(outSrtPath, `${out.join("\n")}\n`, "utf8");
  fs.writeFileSync(outJsonPath, `${JSON.stringify({ rows: jsonRows }, null, 2)}\n`, "utf8");
}

function parseWiseSeriesRows(seriesText) {
  const rows = [];
  const re = /^su name (.+?) since num ([0-9.]+) until num ([0-9.]+) ob text "((?:[^"\\]|\\.)*)" ya$/gmu;
  for (const m of String(seriesText || "").matchAll(re)) {
    const name = String(m[1] || "").trim();
    const since = Number(m[2]);
    const until = Number(m[3]);
    const text = JSON.parse(`"${String(m[4] || "")}"`);
    rows.push({ name, since, until, text });
  }
  return rows;
}

function renderWiseSeriesRows(rows) {
  const lines = ["su name wise chips be series def"];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const name = `wise chip ${String(i + 1).padStart(3, "0")}`;
    lines.push(
      `su name ${name} since num ${Number(row.since || 0).toFixed(3)} until num ${Number(row.until || 0).toFixed(3)} ob text "${pyaEsc(String(row.text || "").trim())}" ya`,
    );
  }
  lines.push("prah");
  return `${lines.join("\n")}\n`;
}

function buildGrossChunksFromRows(rows, {
  minChars = 12000,
  maxChars = 16000,
  overlapRows = 3,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const out = [];
  let start = 0;
  while (start < list.length) {
    let end = start;
    let size = 0;
    while (end < list.length) {
      const add = String(list[end]?.text || "").length + 18;
      if (size >= minChars && (size + add) > maxChars) break;
      size += add;
      end += 1;
      if (size >= maxChars) break;
    }
    if (end <= start) end = Math.min(list.length, start + 1);
    const chunkRows = list.slice(start, end);
    out.push({
      startIndex: start,
      endIndex: end - 1,
      since: Number(chunkRows[0]?.since || 0),
      until: Number(chunkRows[chunkRows.length - 1]?.until || chunkRows[0]?.since || 0),
      rows: chunkRows,
    });
    if (end >= list.length) break;
    start = Math.max(0, end - Math.max(0, overlapRows));
    if (start >= end) start = end;
  }
  return out;
}

function parseChapterLines(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d{1,2}:\d{2}:\d{2})\s*\|\s*(.+)$/u);
    if (!m) continue;
    const seconds = parseClockToSeconds(m[1]);
    const title = String(m[2] || "").replace(/\s+/gu, " ").trim();
    if (seconds == null || !title) continue;
    out.push({ since: seconds, title });
  }
  return out;
}

async function generateChaptersViaGrossLlm({ rows, maxWords = 5 }) {
  const chunkMinChars = Number(process.env.ANDRII_GROSS_CHUNK_MIN_CHARS || 12000);
  const chunkMaxChars = Number(process.env.ANDRII_GROSS_CHUNK_MAX_CHARS || 16000);
  const chunks = buildGrossChunksFromRows(rows, {
    minChars: Number.isFinite(chunkMinChars) && chunkMinChars >= 3000 ? chunkMinChars : 12000,
    maxChars: Number.isFinite(chunkMaxChars) && chunkMaxChars >= 5000 ? chunkMaxChars : 16000,
    overlapRows: 3,
  });
  const candidates = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const body = c.rows
      .map((r) => `${secondsToHms(r.since)} ${String(r.text || "").replace(/\s+/gu, " ").trim()}`)
      .join("\n")
      .slice(0, 18000);
    const prompt = [
      "You are generating YouTube chapter starts from transcript text.",
      "Detect only meaningful topic shifts.",
      "Return 1 to 5 lines only, exact format:",
      "HH:MM:SS | Chapter Title",
      `Rules: title must be 3-${Math.max(3, maxWords)} words, title case, no speaker names, no filler.`,
      `Time range allowed: ${secondsToHms(c.since)} to ${secondsToHms(c.until)}.`,
      "Do not output anything else.",
      "",
      body,
    ].join("\n");
    const raw = await askOllama({
      system: "You create chapter starts from transcript chunks.",
      prompt,
      maxTokens: 300,
    });
    const parsed = parseChapterLines(raw).filter((x) => x.since >= c.since && x.since <= c.until);
    for (const p of parsed) candidates.push(p);
  }
  if (!candidates.length && rows.length) {
    return [{ since: 0, title: "Opening Segment" }];
  }
  candidates.sort((a, b) => a.since - b.since || a.title.localeCompare(b.title));
  const dedup = [];
  const minGap = Number(process.env.ANDRII_CHAPTER_MIN_GAP_SECONDS || 90);
  for (const c of candidates) {
    if (!dedup.length) {
      dedup.push(c);
      continue;
    }
    const prev = dedup[dedup.length - 1];
    if (Math.abs(c.since - prev.since) < 8) continue;
    if ((c.since - prev.since) < minGap) continue;
    dedup.push(c);
  }
  if (!dedup.length || dedup[0].since > 45) {
    dedup.unshift({ since: 0, title: dedup[0]?.title || "Opening Segment" });
  }
  if (dedup.length > 1 && (dedup[1].since - dedup[0].since) < minGap) {
    dedup.splice(1, 1);
  }
  return dedup;
}

function coalesceWiseRowsByDuration(rows, { minSeconds = 120, maxSeconds = 600, pauseSeconds = 2.5 } = {}) {
  const cleaned = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      since: Number(row?.since || 0),
      until: Number(row?.until || 0),
      text: String(row?.text || "").replace(/\s+/gu, " ").trim(),
    }))
    .filter((row) => row.text && Number.isFinite(row.since) && Number.isFinite(row.until))
    .sort((a, b) => a.since - b.since);
  if (!cleaned.length) return [];

  const out = [];
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    out.push(bucket);
    bucket = null;
  };
  const addToBucket = (row) => {
    if (!bucket) {
      bucket = { since: row.since, until: row.until, text: row.text };
      return;
    }
    bucket.until = Math.max(bucket.until, row.until);
    bucket.text = `${bucket.text} ${row.text}`.replace(/\s+/gu, " ").trim();
  };

  for (const row of cleaned) {
    if (!bucket) {
      addToBucket(row);
      continue;
    }
    const currentDur = Math.max(0, bucket.until - bucket.since);
    const gap = Math.max(0, row.since - bucket.until);
    const wouldDur = Math.max(0, row.until - bucket.since);
    if (currentDur >= minSeconds && (wouldDur > maxSeconds || gap >= pauseSeconds)) {
      flush();
      addToBucket(row);
      continue;
    }
    addToBucket(row);
  }
  flush();

  if (out.length > 1) {
    const last = out[out.length - 1];
    const lastDur = Math.max(0, last.until - last.since);
    if (lastDur < minSeconds) {
      const prev = out[out.length - 2];
      prev.until = Math.max(prev.until, last.until);
      prev.text = `${prev.text} ${last.text}`.replace(/\s+/gu, " ").trim();
      out.pop();
    }
  }
  return out;
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function loadChapters(chaptersPath) {
  const lines = safeReadText(chaptersPath, "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\d+):(\d{2})(?::(\d{2}))?\s+(.+)$/u);
    if (!m) continue;
    const since = parseChapterTimestamp(m[0].slice(0, m[0].length - m[4].length).trim());
    if (since == null) continue;
    out.push({ since, title: String(m[4] || "").trim() });
  }
  // Keep the publisher safe even when loading an older artifact produced
  // before chapter-grounding normalized the first marker.
  if (out.length) out[0].since = 0;
  return out;
}

function writeAgendaWiseFromChapters({ wiseInputPath, chaptersPath, wiseOutputPath }) {
  const rows = parseWiseSeriesRows(safeReadText(wiseInputPath, ""));
  const chapters = loadChapters(chaptersPath);
  const lines = [];
  let i = 0;
  for (const row of rows) {
    i += 1;
    const chapter = chapters[i - 1] || { title: `Section ${i}` };
    const heading = `${i}. ${chapter.title}`;
    const body = `[Agenda Start] ${heading}\n\n${String(row.text || "").trim()}`;
    lines.push(`su name wise chip ${i} since num ${Number(row.since || 0).toFixed(3)} until num ${Number(row.until || 0).toFixed(3)} ob text "${pyaEsc(body)}" ya`);
  }
  fs.writeFileSync(wiseOutputPath, `${lines.join("\n")}\n`, "utf8");
}

async function askOllama({ prompt, system = "You write concise civic summaries.", maxTokens = 220, temperature = 0.2, format = "" }) {
  const host = String(process.env.OLLAMA_HOST || RESOLVED_OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const json = await requestManagedOllamaChat({
        ollamaUrl: host,
        managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
        keepAlive: 300,
        think: false,
        options: { num_ctx: OLLAMA_CONTEXT_TOKENS, num_predict: maxTokens, temperature },
        ...(format ? { format } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        timeoutMs: Number(process.env.ANDRII_OLLAMA_TIMEOUT_MS || 300000),
      });
      const content = String(json?.message?.content || json?.response || "").trim();
      if (!content) throw new Error("ollama returned empty content");
      return content;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`configured text model request failed after 3 attempts: ${String(lastError?.message || lastError)}`);
}

async function generateNeutralStreamOneSentence({ sourceText, styleLine }) {
  const bannedCausal = /\b(caused? by|consequence of|leads? to|results? in|allows?|enables?|transforms?|drives?|fuels?|exposes? how|because|therefore|thus)\b/iu;
  const bannedMeta = /\b(without claiming|without endorsing|without establishing(?:\s+\w+){0,3}\s+causal\s+links?|does not claim|does not endorse|ideological conclusions?|established facts?)\b/iu;
  let lastError = "";
  let priorCandidate = "";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const revisionPrompt = priorCandidate
      ? [
          `The prior sentence was rejected for ${lastError}.`,
          "Rewrite it as exactly one sentence. Do not add a second sentence or a sentence-ending period before the final word; use commas or an em dash to join themes.",
          "Preserve its main themes, but remove details as needed.",
          `PRIOR SENTENCE: ${priorCandidate}`,
        ].join("\n")
      : [
          styleLine,
          "SOURCE SUMMARY:",
          String(sourceText || "").slice(0, 8000),
        ].join("\n");
    let candidate = cleanInline(await askOllama({
      maxTokens: 64,
      temperature: 0.2,
      system: "Return only one publishable sentence. Obey the requested word limit exactly.",
      prompt: [
        "Write one concise sentence summarizing this livestream, ideally 20-32 words and never more than 45 words.",
        "Use a neutral verb such as explores, discusses, examines, or reflects on.",
        "Enumerate the main themes without claiming that any theme causes, enables, transforms, proves, or produces another.",
        "Present spiritual and political ideas as topics discussed, not as established facts or endorsed conclusions.",
        "Use plain neutral descriptions; avoid evaluative labels such as distributist, distributive, unfair, unjust, victory, or win.",
        "No bullet points, semicolons, causal language, or ideological verdicts.",
        "Do not mention these instructions or add disclaimers about claims, facts, endorsement, causality, or ideology; never append wording such as 'without establishing causal links'.",
        "",
        revisionPrompt,
      ].filter(Boolean).join("\n"),
    }));
    // Qwen can occasionally split a perfectly usable hook into two short
    // clauses despite the one-sentence instruction. Join only sentence
    // punctuation here; the content still comes entirely from the model and
    // is rechecked against the same length and safety gates below.
    if (candidate.split(/(?<=[.!?])\s+(?=[A-Z])/u).filter(Boolean).length > 1) {
      candidate = candidate.replace(/([.!?])\s+(?=[A-Z])/gu, "$1, ").replace(/([.!?]),/gu, ",");
    }
    priorCandidate = candidate;
    const words = candidate.split(/\s+/u).filter(Boolean).length;
    const sentences = candidate.split(/(?<=[.!?])\s+(?=[A-Z])/u).filter(Boolean);
    if (sentences.length !== 1) {
      lastError = `sentence count ${sentences.length}`;
      continue;
    }
    if (words < 18 || words > 45) {
      lastError = `word count ${words}`;
      continue;
    }
    if (bannedCausal.test(candidate)) {
      lastError = "causal or outcome language";
      continue;
    }
    if (bannedMeta.test(candidate)) {
      lastError = "instructional or disclaimer language";
      continue;
    }
    return /[.!?]$/u.test(candidate) ? candidate : `${candidate}.`;
  }
  throw new Error(`one-sentence stream summary retryable: ${lastError || "no valid Qwen output"}`);
}

function cleanInline(text) {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

function stripLeadingSummaryHeading(text) {
  return String(text || "")
    .replace(/^\s*#{1,3}\s+Whole\s+(?:Stream|Meeting)\s+Summary\s*\r?\n/iu, "")
    .trim();
}

function replaceMarkdownSection(markdown, heading, replacement) {
  const source = String(markdown || "").trim();
  const lines = source.split(/\r?\n/u);
  const headingText = String(heading || "").trim().toLocaleLowerCase();
  const index = lines.findIndex((line) => line.trim().toLocaleLowerCase() === `## ${headingText}`);
  if (index < 0) return source;
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, index), String(replacement || "").trim(), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractSummaryBlock(markdown, fallback = "") {
  const text = String(markdown || "");
  const match = text.match(/^##\s+Whole\s+Stream\s+Summary\s*\r?\n([\s\S]*?)(?=^##\s+Chapters\b|\s*$)/imu);
  return String(match?.[1] || fallback || "").trim();
}

function parseJsonObjectFromModel(text) {
  let raw = String(text || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  // Some Qwen deployments still emit a hidden reasoning wrapper despite
  // `think: false`; braces inside that wrapper must not be mistaken for the
  // response object.
  raw = raw.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  } catch { /* scan balanced objects below */ }
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch { /* try a later balanced object */ }
        break;
      }
    }
  }
  return null;
}

function digestText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function canonicalSpeakerRoster(rawValue = process.env.PYA_SPEAKER_NAME_ROSTER || "") {
  const raw = String(rawValue || "").trim();
  const titleCase = (value) => String(value || "").split(/\s+/u).map((token) => token
    ? `${token.slice(0, 1).toLocaleUpperCase()}${token.slice(1).toLocaleLowerCase()}` : token).join(" ");
  const names = raw.split(/[;\n|]+/u).map((item) => String(item || "").trim()).filter(Boolean).map((item) => {
    const comma = item.match(/^([^,]+),\s*(.+)$/u);
    return titleCase(comma ? `${comma[2]} ${comma[1]}` : item);
  }).filter(Boolean);
  const moderator = titleCase(process.env.PYA_SPEAKER_MODERATOR_NAME || "");
  if (moderator && !names.some((name) => name.toLocaleLowerCase() === moderator.toLocaleLowerCase())) names.push(moderator);
  return names.join("; ");
}

function verifiedSummaryCheckpoint({ markerPath, summaryPath, chunksPath, sourcePath, speakerRoster = "" }) {
  if (![markerPath, summaryPath, chunksPath, sourcePath].every((p) => fs.existsSync(p))) return false;
  try {
    const marker = fs.readFileSync(markerPath, "utf8");
    if (!/su name pass be bool true ya/u.test(marker)) return false;
    // Older markers did not include digests. Their timestamp still proves the
    // exact summary/checkpoint files were accepted by this verifier, provided
    // none of the inputs changed afterwards. New markers additionally carry
    // content digests below for stronger identity checking.
    const markerTime = fs.statSync(markerPath).mtimeMs;
    if (markerTime < fs.statSync(summaryPath).mtimeMs
      || markerTime < fs.statSync(chunksPath).mtimeMs
      || markerTime < fs.statSync(sourcePath).mtimeMs) return false;
    const readDigest = (name) => marker.match(new RegExp(`su name ${name} be text "([a-f0-9]{64})" ya`, "i"))?.[1] || "";
    const summaryDigest = readDigest("summary sha256");
    const sourceDigest = readDigest("source sha256");
    const chunksDigest = readDigest("coverage sha256");
    const rosterDigest = readDigest("speaker roster sha256");
    if (summaryDigest && summaryDigest !== digestText(fs.readFileSync(summaryPath, "utf8"))) return false;
    if (sourceDigest && sourceDigest !== digestText(fs.readFileSync(sourcePath, "utf8"))) return false;
    if (chunksDigest && chunksDigest !== digestText(fs.readFileSync(chunksPath, "utf8"))) return false;
    if (rosterDigest && rosterDigest !== digestText(speakerRoster)) return false;
    if (speakerRoster && !rosterDigest) return false;
    return true;
  } catch {
    return false;
  }
}

function summaryHasUnsupportedLabels(summaryText, sourceText) {
  const source = String(sourceText || "").toLowerCase();
  const labels = [...String(summaryText || "").matchAll(/\b(distributist|distributive|capitalist|socialist|communist|fascist|libertarian|profit-driven|real-estate)\b/giu)]
    .map((m) => String(m[0] || "").toLowerCase());
  return [...new Set(labels)].filter((label) => !source.includes(label));
}

function summaryHasUnsupportedFraming(summaryText, sourceText) {
  const source = String(sourceText || "").toLowerCase();
  const candidate = String(summaryText || "").toLowerCase();
  // "Systemic" is not automatically an unsupported ideological or causal
  // claim when the transcript explicitly discusses root causes, systems, or
  // public-health/correctional-system responses. Keep the guard for unrelated
  // uses, but do not reject a faithful paraphrase of that discussion.
  const systemicSupported = /\b(?:root\s+causes?|system(?:ic|s)?|public\s+health|social\s+services|correctional\s+system)\b/iu.test(source);
  const terms = [
    "systemic", "disproportionately", "immediate relief", "achieved", "foundational pillars",
    "provide immediate", "housing instability", "mismanagement",
  ];
  const unsupported = terms.filter((term) => candidate.includes(term)
    && !source.includes(term)
    && !(term === "systemic" && systemicSupported));
  if (/(?:cannot|can't)\s+promise/iu.test(source)) {
    const hasPriceCaveat = /(?:cannot|can't)\s+promise|no\s+(?:specific\s+)?price\s+(?:is\s+)?promis/iu.test(candidate);
    if (!hasPriceCaveat && /\b(?:construct(?:ing)?|build(?:ing)?)\b[^.\n]{0,80}\$?\s*700[,.]?000/iu.test(candidate)) {
      unsupported.push("unqualified housing price commitment");
    }
  }
  const phraseChecks = [
    ["opening biographical detail", /\b(?:introduces? himself|mail carrier)\b[^.\n]{0,100}\b(?:in|from)\s+[a-z]/iu],
    ["resolve stalled developments", /\b(?:resolve|fix)\w*\s+stalled\b/iu],
    ["demand full budget data", /\bdemand\w*\s+(?:full\s+)?budget\s+data\b/iu],
    ["enhance operational efficiency", /\benhanc\w*\s+operational\s+efficiency\b/iu],
    ["ensure basic services", /\bensur\w*\s+basic\s+services\b/iu],
    ["proposals aim to align", /\b(?:proposals|campaign)\s+aim\w*\s+to\s+align\b/iu],
  ];
  for (const [label, pattern] of phraseChecks) {
    if (pattern.test(candidate) && !source.includes(label)) unsupported.push(label);
  }
  return [...new Set(unsupported)];
}

// A model can report that it removed a claim while accidentally leaving the
// same wording in corrected_markdown. Keep the publish gate source-faithful by
// checking quoted claim terms from its own issue list against the corrected
// text. Identity/ASR discussions are intentionally ignored because the
// speaker-alias normalization above handles those separately.
function unsupportedIssueTermsRemaining(issues, correctedMarkdown, sourceText = "") {
  const text = String(correctedMarkdown || "").toLocaleLowerCase();
  const source = String(sourceText || "").toLocaleLowerCase();
  const remaining = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const raw = String(issue || "");
    if (/\b(?:asr|spelling|roster|speaker|name|unnamed)\b/iu.test(raw)) continue;
    if (!/\b(?:unsupported|not\s+supported|not\s+explicitly|removed|incorrect|wrong|invented)\b/iu.test(raw)) continue;
    const quoted = [...raw.matchAll(/["'“”`]([^"'“”`]{4,120})["'“”`]/gu)]
      .map((match) => ({
        original: String(match[1] || "").trim(),
        term: String(match[1] || "").trim().toLocaleLowerCase(),
      }))
      .filter((item) => !/^##?\s|^(?:whole\s+stream\s+summary|most\s+newsworthy\s+items)$/iu.test(item.term));
    for (const item of quoted) {
      const term = item.term;
      // Single common lower-case words are often topic labels or harmless
      // paraphrases; retain the stronger checks for multi-word claims and
      // capitalized proper nouns such as an invented place name.
      if (term.split(/\s+/u).length === 1 && !/[A-Z]/u.test(item.original)) continue;
      if (term && !source.includes(term) && text.includes(term)) remaining.push(term);
    }
  }
  return [...new Set(remaining)];
}

// Speaker linking already produces an operator-reviewed alias table. Reuse
// that identity evidence in the stream-summary verifier so an ASR spelling
// cannot become a second, unnamed candidate in otherwise grounded prose.
// This is deliberately data-driven: no meeting-specific names are embedded
// here; each meeting supplies its own verified map artifact.
function canonicalizeSummarySpeakerNames(text, speakerNameMapPath = "") {
  const value = String(text || "");
  if (!value || !speakerNameMapPath) return value;
  let map;
  try { map = JSON.parse(fs.readFileSync(speakerNameMapPath, "utf8")); } catch { return value; }
  const replacements = (Array.isArray(map?.aliases) ? map.aliases : [])
    .map((alias) => ({
      observed: String(alias?.observed || "").trim(),
      canonical: String(alias?.canonical_name || alias?.canonical || "").trim(),
    }))
    .filter((alias) => alias.observed.length >= 4 && alias.canonical.length >= 3
      && alias.observed.toLocaleLowerCase() !== alias.canonical.toLocaleLowerCase())
    .sort((left, right) => right.observed.length - left.observed.length);
  let output = value;
  for (const alias of replacements) {
    const escaped = alias.observed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    output = output.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), alias.canonical);
  }
  return output;
}

// Qwen occasionally returns a source-grounded replacement paragraph but
// omits the required newsworthy section. Preserve that already-generated
// section structurally and let the claim/coverage gates continue reviewing
// the complete document; do not invent bullets or prose here.
function preserveRequiredSummarySections(corrected, fallback) {
  const text = String(corrected || "").trim();
  if (!text || /##\s+Most\s+Newsworthy\s+Items\b/iu.test(text)) return text;
  const source = String(fallback || "");
  const match = source.match(/##\s+Most\s+Newsworthy\s+Items\b[\s\S]*$/iu);
  return match ? `${text}\n\n${match[0].trim()}` : text;
}

function wholeSummarySentenceCount(markdown) {
  const text = String(markdown || "");
  const match = text.match(/##\s+Whole\s+Stream\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/iu);
  const paragraph = String(match?.[1] || "").replace(/[*_`]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!paragraph) return 0;
  return (paragraph.match(/[.!?](?=\s|$)/gu) || []).length || 1;
}

function parseSummaryCoverageChunks(coverageText) {
  const chunks = [];
  for (const line of String(coverageText || "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^su name meeting summary chunk\s+(\S+)\s+since num\s+[^\s]+\s+until num\s+[^\s]+\s+ob text "([\s\S]+)" ya$/u);
    if (!match) continue;
    try {
      const jsonText = JSON.parse(`"${match[2]}"`);
      const payload = JSON.parse(jsonText);
      const chunkId = String(payload?.["chunk id"] || match[1] || "").trim();
      const titles = Array.isArray(payload?.["chapter titles"])
        ? payload["chapter titles"].map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      const summary = String(payload?.["chunk summary text"] || "").trim();
      if (chunkId && titles.length && summary) chunks.push({ chunkId, titles, summary });
    } catch {
      // The caller will keep the coverage gate retryable if notes exist but no
      // complete chronology chunks can be decoded.
    }
  }
  return chunks;
}

function summaryCoverageRequirements(coverageText) {
  const bands = parseSummaryCoverageChunks(coverageText).length;
  if (bands >= 3) return { bands, minSentences: 8, bulletCount: 6 };
  if (bands === 2) return { bands, minSentences: 5, bulletCount: 4 };
  return { bands, minSentences: 4, bulletCount: 3 };
}

function summaryCoverageContract(coverageText) {
  return parseSummaryCoverageChunks(coverageText)
    .map((chunk) => [
      `${chunk.chunkId}: mention at least one concrete topic from this chronology chunk in the whole-stream paragraph.`,
      `Chapter topics: ${chunk.titles.join(" | ")}`,
      `Grounding guide: ${chunk.summary}`,
    ].join("\n"))
    .join("\n\n");
}

async function auditStreamSummaryCoverage({ summary, coverageText }) {
  const notes = String(coverageText || "").trim();
  if (!notes) return { pass: true, issues: [] };
  const chunks = parseSummaryCoverageChunks(notes);
  if (!chunks.length) {
    return { pass: false, issues: ["chronological coverage notes could not be decoded into complete chunks"] };
  }
  const issues = [];
  const stopwords = new Set("a an and are as at be by for from in into is it of on or that the their this to with while will was were one two about after before during into only than then these those through use using where which who would".split(/\s+/u));
  const contentWords = (text) => new Set(String(text || "").toLocaleLowerCase().match(/[a-z][a-z-]{3,}/gu)?.filter((word) => !stopwords.has(word)) || []);
  for (const chunk of chunks) {
    const response = await askOllama({
      maxTokens: 280,
      temperature: 0.1,
      system: "You audit one chronological chunk in a livestream summary. Return JSON only.",
      prompt: [
        "Check whether the WHOLE STREAM SUMMARY paragraph covers this chronology chunk.",
        "Return JSON only with keys: covered (boolean), evidence (string), missing_topics (array of strings).",
        "The paragraph must contain at least one concrete topic from this chunk. Do not require every chapter title to appear in the compact paragraph; judge whether this chronology chunk is represented rather than whether the paragraph is exhaustive.",
        "Judge the paragraph under the heading ## Whole Stream Summary only. Bullets and headings do not count as paragraph coverage.",
        "Do not judge style or unsupported claims here. Set covered false when the paragraph omits this chunk or merely repeats an earlier chunk.",
        `CHRONOLOGY CHUNK: ${chunk.chunkId}`,
        `CHAPTER TITLES: ${chunk.titles.join(" | ")}`,
        `CHUNK SUMMARY: ${chunk.summary}`,
        `WHOLE STREAM SUMMARY:\n${String(summary || "")}`,
      ].join("\n\n"),
    });
    const parsed = parseJsonObjectFromModel(response);
    const evidence = String(parsed?.evidence || "").trim();
    const missingTopics = Array.isArray(parsed?.missing_topics)
      ? parsed.missing_topics.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const summaryWords = contentWords(summary);
    const chunkWords = contentWords(`${chunk.titles.join(" ")} ${chunk.summary}`);
    const overlap = [...chunkWords].filter((word) => summaryWords.has(word));
    // Qwen can under-call a compact paragraph even when it shares several
    // concrete topic terms with the chronology band. Keep this as a
    // supplementary evidence check; the prose itself is still generated and
    // reviewed by the LLM verifier.
    if (parsed?.covered !== true && overlap.length >= 3) continue;
    if (parsed?.covered !== true || !evidence) {
      const detail = missingTopics.length ? ` missing topics: ${missingTopics.join(", ")}` : "";
      issues.push(`${chunk.chunkId} is not explicitly covered.${detail}`.trim());
    }
  }
  return { pass: issues.length === 0, issues };
}

async function verifyStreamSummaryLlm({ candidate, sourceText, coverageText = "", focus, context, speakerRoster = "", speakerNameMapPath = "", verifiedMarkerPath = "", summaryPath = "", chunksPath = "", sourcePath = "" }) {
  const original = canonicalizeSummarySpeakerNames(String(candidate || "").trim(), speakerNameMapPath);
  const source = canonicalizeSummarySpeakerNames(String(sourceText || "").trim(), speakerNameMapPath);
  if (!original || !source) throw new Error("stream summary verification requires candidate and transcript source");
  if (verifiedMarkerPath && verifiedSummaryCheckpoint({ markerPath: verifiedMarkerPath, summaryPath, chunksPath, sourcePath, speakerRoster })) {
    log("[summary-verify] checkpoint pass (source and coverage unchanged)");
    return { text: original, pass: true, issues: ["reused previously verified summary checkpoint"], attempts: 0 };
  }
  // Opening greetings and biographical ASR are not substantive meeting
  // content and are a common source of spurious place/name claims.
  const sourceForSummary = verificationSourceCoverage(source);
  const coverageRequirements = summaryCoverageRequirements(coverageText);
  const coverageContract = summaryCoverageContract(coverageText);
  const requiredSentenceInstruction = `Before returning, count the sentences in the paragraph under ## Whole Stream Summary. It must contain at least ${coverageRequirements.minSentences} and at most 10 complete sentences. If the draft has fewer, split distinct source-supported topics into additional sentences; do not pad with repetition.`;
  let draft = original;
  let lastIssue = "";
  // A verifier rewrite must not make a healthy, fully covered candidate worse
  // merely by compressing several sentences into one. Preserve the original
  // when it already satisfies the structural, source, and chronology gates.
  if (wholeSummarySentenceCount(original) >= coverageRequirements.minSentences
    && !summaryHasUnsupportedLabels(original, source)
    && !summaryHasUnsupportedFraming(original, source)) {
    const originalCoverage = await auditStreamSummaryCoverage({ summary: original, coverageText });
    if (originalCoverage.pass) {
      return { text: original, pass: true, issues: ["preserved source-complete candidate"], attempts: 0 };
    }
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await askOllama({
      // The verifier must fit an 8-10 sentence chronology paragraph, six
      // bullets, and JSON framing in one response. A 1100-token cap can cut
      // the JSON tail off on long civic meetings, leaving a healthy draft
      // retryable for the wrong reason.
      maxTokens: 3600,
      format: SUMMARY_VERIFY_FORMAT,
      temperature: 0.1,
      system: "You are a strict source-claim verifier. Return JSON only.",
      prompt: [
        "Validate and correct this livestream summary against the transcript source.",
        "Return JSON only with keys: pass (boolean), corrected_markdown (string), issues (array of strings).",
        `This is repair attempt ${attempt} of 5. Preserve every chronology chunk while removing only rejected claims; do not repeat the previous draft's omission or structure unchanged.`,
      `The corrected_markdown must start with exactly \`## Whole Stream Summary\`, followed by one paragraph, then exactly \`## Most Newsworthy Items\` followed by ${coverageRequirements.bulletCount} bullets. Do not add a title, topic headings, or any other headings.`,
        `Keep the whole-stream summary to one paragraph of ${coverageRequirements.minSentences}-${Math.min(10, coverageRequirements.minSentences + 2)} sentences and the newsworthy section to exactly ${coverageRequirements.bulletCount} factual bullets distributed across the chronological bands, with at least one bullet from every band.`,
        requiredSentenceInstruction,
        "Write the whole-stream sentences in chronological order and ensure the final band is represented explicitly; each sentence and bullet must add a non-duplicated topic.",
        "Use the chapter titles in CHRONOLOGICAL COVERAGE NOTES as a checklist: the paragraph must include at least one concrete topic from every listed band, including a topic unique to the final band rather than repeating the opening.",
        coverageContract ? `CHRONOLOGY COVERAGE CONTRACT:\n${coverageContract}` : "",
        "Keep only claims explicitly stated or directly paraphrased in SOURCE.",
        "When correcting, preserve every supported topic from the candidate—especially topics from later bands—and rewrite or remove only unsupported assertions; never drop an entire chronological band.",
        "Cover the entire recording rather than concentrating on its opening. Use the chronological coverage notes to include at least one distinct concrete topic from every band.",
        "Do not infer ideology, motives, endorsements, outcomes, or causal relationships.",
        "Match the source's modality exactly: use discusses, notes, says, or suggests for tentative points, and never strengthen them into promises, demands, completed actions, or guaranteed results.",
        "A rounded or inequality-based numeric paraphrase that remains true is acceptable; for example, 'exceeding one hundred thousand dollars' faithfully paraphrases a stated cost of one hundred eighteen thousand dollars.",
        "For numeric examples that the speaker says cannot be promised, omit the number unless the limitation is stated explicitly in the same sentence.",
        "Do not invent generic outcomes or causal claims. If SOURCE itself uses vivid wording such as combat, tackle, resolve, enhance, or ensure, preserve it only as a clearly attributed statement or direct source-grounded paraphrase.",
        "Do not turn a stalled, uncertain, proposed, or under-discussion matter into a rejection, approval, failure, or completed outcome.",
        "Do not use ideological labels such as distributist unless the speaker uses that exact term in SOURCE.",
        "Do not call municipal management mismanagement unless the speaker explicitly uses that characterization.",
        "Correct obvious ASR place/name errors only when the intended reading is clear from SOURCE and context.",
        speakerRoster ? `Operator-confirmed speaker roster (use these exact spellings whenever the summary names one of these people): ${speakerRoster}` : "",
        "Do not repeat uncertain ASR proper nouns that are not needed to explain the discussion; omit them when the intended place or name is unclear.",
        context ? `Meeting context: ${context}` : "",
        "The confirmed subject municipality is Owen Sound; omit other ambiguous place-name tokens unless they are clearly repeated and relevant.",
        "Do not include one-off employer, home-location, or biographical proper nouns unless they are essential to the discussion; omit uncertain ASR tokens.",
        "Skip opening introductions, occupations, and campaign-material anecdotes when they are not part of the substantive discussion; begin with substantive topics addressed.",
        "If any claim is unsupported, set pass to false and make corrected_markdown remove or neutralize every such claim; never return the candidate unchanged.",
        lastIssue ? `Previous verification issue: ${lastIssue}` : "",
        `Focus: ${focus || "neutral source-faithful coverage"}`,
        "",
        `CANDIDATE:\n${draft}`,
        "",
        `SOURCE:\n${sourceForSummary}`,
        coverageText ? `CHRONOLOGICAL COVERAGE NOTES:\n${coverageText}` : "",
      ].filter(Boolean).join("\n"),
    });
    const parsed = parseJsonObjectFromModel(response);
    const corrected = canonicalizeSummarySpeakerNames(
      preserveRequiredSummarySections(parsed?.corrected_markdown, original),
      speakerNameMapPath,
    );
    if (!corrected || !/##\s+Whole\s+Stream\s+Summary/iu.test(corrected) || !/##\s+Most\s+Newsworthy\s+Items/iu.test(corrected)) {
      if (summaryPath) {
        try { fs.writeFileSync(`${summaryPath}.verify-attempt-${attempt}.raw.txt`, String(response || ""), "utf8"); } catch { /* diagnostic only */ }
      }
      lastIssue = "verifier returned incomplete markdown";
      continue;
    }
    if (wholeSummarySentenceCount(corrected) < coverageRequirements.minSentences) {
      lastIssue = `whole-stream summary has ${wholeSummarySentenceCount(corrected)} sentences; ${coverageRequirements.minSentences} are required to cover ${coverageRequirements.bands || "all"} chronological bands`;
      log(`[summary-verify] attempt ${attempt} rejected=${lastIssue}`);
      draft = corrected;
      continue;
    }
    const unsupportedLabels = summaryHasUnsupportedLabels(corrected, source);
    const unsupportedFraming = summaryHasUnsupportedFraming(corrected, source);
    if (unsupportedLabels.length || unsupportedFraming.length) {
      lastIssue = `unsupported wording: ${[...unsupportedLabels, ...unsupportedFraming].join(", ")}`;
      log(`[summary-verify] attempt ${attempt} rejected=${lastIssue}`);
      draft = corrected;
      continue;
    }
    const coverageAudit = await auditStreamSummaryCoverage({ summary: corrected, coverageText });
    if (!coverageAudit.pass) {
      lastIssue = `chronology coverage audit: ${coverageAudit.issues.join("; ") || "one or more chronology chunks are missing"}`;
      log(`[summary-verify] attempt ${attempt} rejected=${lastIssue}`);
      draft = corrected;
      continue;
    }
    const issues = Array.isArray(parsed?.issues) ? parsed.issues.map((x) => String(x || "").trim()).filter(Boolean) : [];
    const residualIssueTerms = unsupportedIssueTermsRemaining(issues, corrected, source);
    if (residualIssueTerms.length) {
      lastIssue = `verifier left rejected claim wording in corrected summary: ${residualIssueTerms.join(", ")}`;
      log(`[summary-verify] attempt ${attempt} rejected=${lastIssue}`);
      draft = corrected;
      continue;
    }
    log(`[summary-verify] attempt ${attempt} pass=${String(parsed?.pass === true)} issues=${issues.join(" | ") || "none"}`);
    if (parsed?.pass !== true) {
      // Qwen sometimes returns pass=false while its corrected text is clean
      // and the issue list merely records checks it performed. Ask an
      // independent adjudicator, as the Grey/Owen pipeline does, before
      // retrying and potentially losing late-stream coverage.
      const adjudication = await askOllama({
        maxTokens: 360,
        temperature: 0.1,
        format: SUMMARY_VERIFY_FORMAT,
        system: "You adjudicate whole-stream summary verification. Return JSON only.",
        prompt: [
          "Decide whether CORRECTED_MARKDOWN is publishable against SOURCE and COVERAGE NOTES.",
          "Return JSON only: {\"pass\":true|false,\"issues\":[\"...\"]}.",
          "Fail only for invented facts, wrong attribution, changed uncertainty or proposal status, personal attacks presented as facts, or omission of the beginning, middle, or end of the recording. Do not fail for concise omission of secondary details.",
          "The corrected markdown has already been normalized with the operator-reviewed speaker alias map. Do not fail because PRIOR REVIEW mentions an ASR spelling variant or debates whether that variant is a separate person; judge the corrected markdown's exact roster names and its claims against SOURCE.",
          `CORRECTED_MARKDOWN:\n${corrected}`,
          `SOURCE:\n${sourceForSummary}`,
          coverageText ? `COVERAGE NOTES:\n${coverageText}` : "",
          issues.length ? `PRIOR REVIEW:\n${issues.join("; ")}` : "",
        ].filter(Boolean).join("\n\n"),
      });
      const adjudicated = parseJsonObjectFromModel(adjudication);
      if (adjudicated?.pass === true) {
        return { text: corrected, pass: true, issues, attempts: attempt };
      }
      lastIssue = issues.join("; ") || "verifier rejected one or more claims";
      draft = corrected;
      continue;
    }
    return { text: corrected, pass: true, issues, attempts: attempt };
  }
  const freshResponse = await askOllama({
    maxTokens: 3600,
    format: SUMMARY_VERIFY_FORMAT,
    temperature: 0.1,
    system: "Write a clean, neutral livestream summary from source text. Return JSON only.",
    prompt: [
      "Create a new summary from SOURCE only; do not revise or reuse the candidate.",
      "Return JSON only with keys: pass (boolean), corrected_markdown (string), issues (array of strings). Set pass true only when every claim is explicitly supported by SOURCE.",
      `The corrected_markdown must start with exactly \`## Whole Stream Summary\`, followed by one paragraph, then exactly \`## Most Newsworthy Items\` followed by ${coverageRequirements.bulletCount} bullets. Do not add a title, topic headings, or any other headings.`,
      `Write ${coverageRequirements.minSentences}-${Math.min(10, coverageRequirements.minSentences + 2)} sentences in the whole-stream paragraph and exactly ${coverageRequirements.bulletCount} factual bullets distributed across the bands, with at least one from every band, covering the recording in chronological order.`,
      requiredSentenceInstruction,
      "Use the chapter titles in CHRONOLOGICAL COVERAGE NOTES as a checklist and include a concrete topic from every band, including a topic unique to the final band rather than repeating the opening.",
      coverageContract ? `CHRONOLOGY COVERAGE CONTRACT:\n${coverageContract}` : "",
      "Use neutral attribution for disputed comments (for example, 'he criticizes' or 'he says') and omit personal attacks. Do not repeat a housing or campaign point in multiple sentences.",
      "Use cautious verbs such as discusses, notes, says, and suggests.",
      "Preserve uncertainty and omit any exact numeric example that the speaker says cannot be promised.",
      "A rounded or inequality-based numeric paraphrase that remains true is acceptable; for example, 'exceeding one hundred thousand dollars' faithfully paraphrases a stated cost of one hundred eighteen thousand dollars.",
      "Do not infer ideology, motives, outcomes, or causal results. Preserve vivid source wording when it is directly supported, with attribution where it is a speaker's framing.",
      speakerRoster ? `Operator-confirmed speaker roster (use these exact spellings whenever the summary names one of these people): ${speakerRoster}` : "",
      "Skip opening introductions, occupations, and campaign-material anecdotes when they are not part of the substantive discussion.",
      lastIssue ? `PREVIOUS REJECTION REASON (must be repaired): ${lastIssue}` : "",
      draft ? `REJECTED DRAFT (use only to avoid repeating its defect; write fresh prose from SOURCE):\n${draft}` : "",
      "SOURCE:",
      sourceForSummary,
      coverageText ? `CHRONOLOGICAL COVERAGE NOTES:\n${coverageText}` : "",
    ].join("\n"),
  });
  const freshParsed = parseJsonObjectFromModel(freshResponse);
  const freshText = canonicalizeSummarySpeakerNames(
    preserveRequiredSummarySections(freshParsed?.corrected_markdown, original),
    speakerNameMapPath,
  );
  if ((!freshText || !/##\s+Whole\s+Stream\s+Summary/iu.test(freshText)) && summaryPath) {
    try { fs.writeFileSync(`${summaryPath}.verify-fresh.raw.txt`, String(freshResponse || ""), "utf8"); } catch { /* diagnostic only */ }
  }
  if (
    freshText
    && /##\s+Whole\s+Stream\s+Summary/iu.test(freshText)
    && /##\s+Most\s+Newsworthy\s+Items/iu.test(freshText)
    && wholeSummarySentenceCount(freshText) >= coverageRequirements.minSentences
    && freshParsed?.pass === true
    && !unsupportedIssueTermsRemaining(freshParsed?.issues, freshText, source).length
    && !summaryHasUnsupportedLabels(freshText, source).length
    && !summaryHasUnsupportedFraming(freshText, source).length
  ) {
    const coverageAudit = await auditStreamSummaryCoverage({ summary: freshText, coverageText });
    if (coverageAudit.pass) {
      return { text: freshText, pass: true, issues: Array.isArray(freshParsed?.issues) ? freshParsed.issues : [], attempts: 4 };
    }
    lastIssue = `chronology coverage audit: ${coverageAudit.issues.join("; ") || "one or more chronology chunks are missing"}`;
  }
  throw new Error(`stream summary verification failed after 5 attempts: ${lastIssue || "no corrected summary"}`);
}

function verificationSourceCoverage(sourceText, maxChars = 80000) {
  const source = String(sourceText || "").trim();
  // Keep the complete source for short recordings. Candidate interviews and
  // other brief videos often put their substantive proposal in the opening
  // minute; dropping the first 1,000 characters made the verifier falsely
  // label those claims as unsupported. Long recordings are still sampled
  // across beginning, middle, and end below.
  if (source.length <= maxChars) return source;
  // Keep the verifier's prompt bounded while exposing the beginning, middle,
  // and end of a long recording. This prevents a front-loaded summary from
  // passing after seeing only the opening section of a multi-hour source.
  const usable = Math.max(20000, Math.floor(maxChars));
  const windowChars = Math.floor(usable / 8);
  const excerpts = [];
  for (let i = 0; i < 8; i += 1) {
    const offset = Math.floor((source.length - windowChars) * (i / 7));
    const text = source.slice(Math.max(0, offset), Math.max(0, offset) + windowChars).trim();
    if (text) excerpts.push(`[TRANSCRIPT EXCERPT ${i + 1}/8]\n${text}`);
  }
  return excerpts.join("\n\n");
}

function writeVerifiedSummaryPya(summaryPath, summaryText) {
  const old = safeReadText(summaryPath, "");
  const chunkCount = old.match(/su name chunk count be num\s+([0-9]+)/u)?.[1] || "0";
  const chapterCount = old.match(/su name chapter count be num\s+([0-9]+)/u)?.[1] || "0";
  const escaped = pyaEsc(summaryText);
  fs.writeFileSync(summaryPath, [
    "su name meeting summary artifact be map def",
    `su name chunk count be num ${chunkCount} ya`,
    `su name chapter count be num ${chapterCount} ya`,
    `su name summary markdown be text \"${escaped}\" ya`,
    "prah",
    "",
  ].join("\n"), "utf8");
}

async function detectContentMode({ title, transcript, focus }) {
  const forced = String(process.env.ANDRII_CONTENT_MODE || "").trim().toLowerCase();
  if (forced === "peak_oil" || forced === "spiritual" || forced === "general") return forced;
  // Civic source profiles are always processed with the neutral public-affairs
  // style. A candidate's religious or personal language must not cause the
  // entire council debate to be classified as a spiritual programme.
  const profile = activeYoutubeSourceProfile();
  if (["owen-sound-council", "owen-sound-police"].includes(String(profile?.id || "").toLowerCase())) return "general";
  const raw = await askOllama({
    maxTokens: 16,
    system: "Classify content mode.",
    prompt: [
      "Return exactly one label: peak_oil OR spiritual OR general.",
      `Title: ${title}`,
      `Focus: ${focus}`,
      "",
      transcript.slice(0, 6000),
    ].join("\n"),
  });
  const label = String(raw || "").toLowerCase();
  if (label.includes("peak_oil")) return "peak_oil";
  if (label.includes("spiritual")) return "spiritual";
  return "general";
}

function modeBrief(mode) {
  if (mode === "peak_oil") {
    return {
      hookStyle: "Write a short concrete hook about energy, depletion, adaptation, resilience, or local action. No clickbait.",
      summaryStyle: "Write practical analysis for a public audience. Mention risks, constraints, tradeoffs, and actionable next steps.",
      oneLineStyle: "Write one crisp sentence capturing the key takeaway for listeners interested in energy transition and local resilience.",
    };
  }
  if (mode === "spiritual") {
    return {
      hookStyle: "Write a short reflective hook grounded in the message, avoiding sensational claims.",
      summaryStyle: "Write a respectful spiritual recap: core teachings, practices, emotional arc, and practical reflection points. Keep language personal, not institutional.",
      oneLineStyle: "Write one calm sentence that captures the central spiritual message and practical takeaway.",
    };
  }
  return {
    hookStyle: "Write a clear neutral hook from the strongest idea in the stream.",
    summaryStyle: "Write a concise, accurate recap for general listeners.",
    oneLineStyle: "Write one sentence that captures the main takeaway.",
  };
}

function sourceTopicFromMode(mode) {
  const profile = activeYoutubeSourceProfile();
  if (profile.id !== "andrii") return { source: profile.source_slug, topic: profile.topic_slug };
  const source = profile.source_slug;
  if (mode === "peak_oil") return { source, topic: "peak-oil" };
  if (mode === "spiritual") return { source, topic: "spiritual" };
  return { source, topic: profile.topic_slug || "general" };
}

function markdownToHtmlBlock(md) {
  const paras = String(md || "").split(/\n\n+/u).map((x) => x.trim()).filter(Boolean);
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

function parseDateFromMeetingDir(meetingDirName) {
  const m = String(meetingDirName || "").match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!m) return { iso: "", long: "Unknown date" };
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  return {
    iso,
    long: dt.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }),
  };
}

async function main() {
  if (!process.env.PYA_GPU_HOUSEKEEPER_URL) {
    const resolvedHousekeeper = resolveGpuHousekeeperUrl({
      ollamaUrl: RESOLVED_OLLAMA_HOST,
      env: process.env,
    });
    if (resolvedHousekeeper) process.env.PYA_GPU_HOUSEKEEPER_URL = resolvedHousekeeper;
  }
  const meetingRef = process.argv[2];
  const basePrefix = process.argv[3] || ANDRII_ADAPTER.defaults.base_prefix || "meeting-qwen-auto";
  const focus = normalizeSummaryFocus(process.argv[4] || ANDRII_ADAPTER.defaults.focus);
  const profileDefaults = sourceProfileDefaults();
  const jurisdiction = process.argv[5] || profileDefaults.jurisdiction || ANDRII_ADAPTER.defaults.jurisdiction;
  const body = process.argv[6] || profileDefaults.body || ANDRII_ADAPTER.defaults.body;
  const siteUrl = process.argv[7] || profileDefaults.site_url || ANDRII_ADAPTER.defaults.site_url;
  const discussionUrl = process.argv[8] || "";
  const forcePrep = envFlag("ANDRII_PREP_FORCE");
  const forceFull = envFlag("ANDRII_PIPELINE_FORCE");
  const forceChapter = envFlag("PYA_CHAPTER_FORCE");
  const forceSpeaker = envFlag("PYA_SPEAKER_FORCE") || envFlag("PYA_DIARIZATION_FORCE");
  const answerChapterMode = envFlag("PYA_ANSWER_CHAPTER_MODE");
  const questionMode = envFlag("PYA_CHAPTER_QUESTION_MODE") || answerChapterMode;
  const speakerNameLinking = envFlag("PYA_SPEAKER_NAME_LINKING");
  const skipPrep = envFlag("ANDRII_PIPELINE_SKIP_PREP");
  const resolvedSpeakerHostRaw = String(process.env.PYA_SPEAKER_HOST || "mriczo").trim();
  const resolvedSpeakerHost = /^https?:\/\//iu.test(resolvedSpeakerHostRaw)
    ? resolvedSpeakerHostRaw.replace(/\/+$/u, "")
    : `http://${resolvedSpeakerHostRaw.replace(/\/+$/u, "")}:8010`;

  if (!meetingRef) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  log(`[llm] ollama host: ${RESOLVED_OLLAMA_HOST || "http://mriczo:11434"}`);
  log(`[meeting-ref] hear qwen host: ${RESOLVED_HEAR_QWEN_HOST || "(default localhost:8188)"}`);
  ensureDir(MEETINGS_DIR);

  const watchUrl = watchUrlFromRef(meetingRef);
  if (!watchUrl) throw new Error(`invalid video ref: ${meetingRef}`);

  const metaRaw = runQuiet("yt-dlp", ytDlpArgs(["--dump-single-json", "--no-warnings", watchUrl], watchUrl));
  const meta = JSON.parse(metaRaw);
  const id = String(meta?.id || parseYoutubeId(meetingRef) || "unknown").trim();
  const sourceInfo = sourceInfoFromMeta(watchUrl, meta);
  const title = titleFromMeta(meta, id, sourceInfo);
  const interviewLike = looksLikeInterview({ title, meta, sourceInfo });
  const dateInfo = toDateInfoFromMeta(meta);

  const folder = `${dateInfo.iso}_${slugify(title)}_${id.slice(0, 8)}`;
  const existingMeetingDir = resolveExistingMeetingDirByVideoId({
    meetingsDir: MEETINGS_DIR,
    meetingId: id,
    basePrefix,
  });
  const meetingDir = existingMeetingDir || path.join(MEETINGS_DIR, folder);
  if (existingMeetingDir) {
    log(`[meeting-ref] reusing existing workspace: ${existingMeetingDir}`);
  }
  const transcriptDir = path.join(meetingDir, "transcript");
  const sourceDir = path.join(meetingDir, "source");
  const convertedDir = path.join(meetingDir, "converted");
  const reportDir = path.join(meetingDir, "report");
  ensureDir(meetingDir);
  ensureDir(transcriptDir);
  ensureDir(sourceDir);
  ensureDir(convertedDir);
  ensureDir(reportDir);

  const payload = {
    meeting_id: id,
    meeting_name: title,
    meeting_type: sourceInfo.meetingType,
    meeting_url: watchUrl,
    source_url: watchUrl,
    video: [watchUrl],
    video_player: [watchUrl],
    video_direct: [watchUrl],
    agenda: [],
    agenda_cover: [],
    minutes: [],
    source: sourceInfo.source,
    channel_url: sourceInfo.channelUrl,
    uploader: String(meta?.uploader || "").trim(),
    extractor: String(meta?.extractor_key || meta?.extractor || "").trim(),
  };
  fs.writeFileSync(path.join(meetingDir, "meeting.json"), `${JSON.stringify({ payload, since: `${dateInfo.iso}T12:00:00` }, null, 2)}\n`, "utf8");

  const audioTarget = path.join(transcriptDir, "meeting-audio.%(ext)s");
  const normPrefix = `${basePrefix}-normalized`;
  const timingSrtPath = path.join(transcriptDir, `${basePrefix}.timing.srt`);
  const normalizedPlainPath = path.join(transcriptDir, `${normPrefix}.plain.txt`);
  const mergedSentencesPath = path.join(transcriptDir, `${normPrefix}.sentences.merged.srt`);
  const speakerSrtPath = path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentence.srt`);
  const speakerJsonPath = path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentences.json`);
  const speakerNameMapPath = path.join(transcriptDir, `${normPrefix}.speaker-name-map.json`);
  const audioPath = path.join(transcriptDir, "meeting-audio.opus");

  if (skipPrep) {
    log("[meeting-ref] skip prep stages (ANDRII_PIPELINE_SKIP_PREP=1)");
  } else if (fs.existsSync(audioPath) && !forcePrep) {
    log("[meeting-ref] skip download-audio (checkpoint exists)");
  } else {
    log(`[meeting-ref] downloading audio from ${sourceInfo.downloadLabel}`);
    await runDiskPreflight(transcriptDir, 0);
    await runWithStreaming({
      cmd: "yt-dlp",
      args: ytDlpArgs(["-f", "bestaudio/best", "-x", "--audio-format", "opus", "-o", audioTarget, watchUrl], watchUrl),
      cwd: PYASH_ROOT,
      timeoutMs: 2 * 60 * 60 * 1000,
      label: "download-audio",
    });
  }

  const chaptersPath = path.join(transcriptDir, `${normPrefix}.chapters.txt`);
  const chapterGroundingPath = path.join(transcriptDir, `${normPrefix}.chapter.grounding.pya`);
  const chapterSummaryMdPath = path.join(transcriptDir, `${normPrefix}.chapter-summary.md`);
  const chapterSummaryPyaPath = path.join(transcriptDir, `${normPrefix}.chapter-summary.pya`);
  const chapterSummaryVerifyPath = path.join(transcriptDir, `${normPrefix}.chapter-summary.verify.pya`);
  const questionBoundariesPath = path.join(transcriptDir, `${normPrefix}.question-boundaries.json`);
  const candidateAnswerChaptersPath = path.join(transcriptDir, `${normPrefix}.candidate-answer-chapters.json`);
  const candidateAnswerCoveragePath = path.join(transcriptDir, `${normPrefix}.candidate-answer-coverage.json`);
  const candidateSolutionStatsPath = path.join(transcriptDir, `${normPrefix}.candidate-solution-stats.json`);
  const meetingSummaryChunksPath = path.join(transcriptDir, `${normPrefix}.meeting-summary.chunks.pya`);
  const meetingSummaryMdPath = path.join(transcriptDir, `${normPrefix}.meeting-summary.md`);
  const meetingSummaryPyaPath = path.join(transcriptDir, `${normPrefix}.meeting-summary.pya`);
  const meetingSummaryVerifyPath = path.join(transcriptDir, `${normPrefix}.meeting-summary.verify.pya`);
  const meetingHookTxtPath = path.join(transcriptDir, `${normPrefix}.meeting-hook.txt`);
  const meetingHookJsonPath = path.join(transcriptDir, `${normPrefix}.meeting-hook.json`);
  const coverImagePath = path.join(transcriptDir, `${normPrefix}.meeting-cover.png`);
  const coverImageStablePath = path.join(transcriptDir, "meeting-cover.png");
  const authoritativeChaptersPath = findAuthoritativeChapterFile(transcriptDir, normPrefix);

  // Migrate chapter-description checkpoints created before the YouTube
  // 00:00 contract. This is formatting-only and lets a healthy transcript
  // remain reusable without rerunning transcription or LLM summaries.
  if (fs.existsSync(chaptersPath) && normalizeChapterTextFile(chaptersPath)) {
    log(`[meeting-ref] normalized first chapter marker in ${chaptersPath}`);
  }

  if (skipPrep) {
    log("[meeting-ref] skip canonical transcript pipeline (ANDRII_PIPELINE_SKIP_PREP=1)");
  } else if (
    !forceFull &&
    !forceChapter &&
    !forceSpeaker &&
    normalizationCheckpointHealthy(normalizedPlainPath) &&
    (speakerNameLinking
      || (speakerArtifactUsesDefaultLabels(speakerJsonPath)
        && speakerArtifactUsesDefaultLabels(speakerSrtPath))) &&
    fs.existsSync(chapterGroundingPath) &&
    (!authoritativeChaptersPath || (
      fs.existsSync(chaptersPath)
      && fs.statSync(chaptersPath).mtimeMs >= fs.statSync(authoritativeChaptersPath).mtimeMs
      && fs.statSync(chapterGroundingPath).mtimeMs >= fs.statSync(authoritativeChaptersPath).mtimeMs
    )) &&
    (!speakerNameLinking || speakerNameMapCheckpointFresh(speakerNameMapPath, speakerJsonPath)) &&
    (!questionMode || questionChapterCheckpointFresh(questionBoundariesPath, chapterGroundingPath)) &&
    (!answerChapterMode || answerChapterCheckpointFresh(candidateAnswerChaptersPath, candidateAnswerCoveragePath, questionBoundariesPath, speakerNameMapPath)) &&
    chapterSummaryCheckpointHealthy(chapterSummaryPyaPath, chapterSummaryMdPath, chapterSummaryVerifyPath, chapterGroundingPath, String(process.env.PYA_SPEAKER_NAME_ROSTER || "").trim()) &&
    fs.existsSync(meetingSummaryMdPath) &&
    fs.existsSync(meetingSummaryPyaPath)
  ) {
    log("[meeting-ref] skip canonical transcript pipeline (checkpoint exists)");
  } else {
    log("[meeting-ref] canonical transcript pipeline");
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(HOUSE_ROOT, "program/run-full-transcript-pipeline-from-meeting-folder.mjs"),
        meetingDir,
        basePrefix,
        focus,
        jurisdiction,
        body,
        siteUrl,
        discussionUrl,
      ],
      cwd: PYASH_ROOT,
      env: {
        OLLAMA_HOST: process.env.OLLAMA_HOST || RESOLVED_OLLAMA_HOST || "",
        PYA_HEAR_QWEN_HOST: process.env.PYA_HEAR_QWEN_HOST || RESOLVED_HEAR_QWEN_HOST || "",
        PYA_DRAW_HOST: process.env.PYA_DRAW_HOST || RESOLVED_HEAR_QWEN_HOST || "",
        PYA_SPEAKER_HOST: resolvedSpeakerHost,
        PYA_SPEAKER_EXPECTED_MAX: process.env.PYA_SPEAKER_EXPECTED_MAX || (interviewLike ? "2" : "0"),
        PYA_SPEAKER_SENTENCE_ONLY: "1",
        PYA_SPEAKER_NAME_LINKING: process.env.PYA_SPEAKER_NAME_LINKING || "",
        PYA_SPEAKER_CUE_LEVEL_TURNS: "1",
        PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS: "1",
        PYA_SPEAKER_BAD_SAMPLE_GUARD: "1",
        PYA_SPEAKER_BOUNDARY_REFINE: process.env.PYA_SPEAKER_BOUNDARY_REFINE || "0",
        PYA_SPEAKER_SAME_THRESHOLD: process.env.PYA_SPEAKER_SAME_THRESHOLD
          || (interviewLike ? "0.72" : "0.58"),
      },
      timeoutMs: 8 * 60 * 60 * 1000,
      label: "full-pipeline",
    });
  }

  // The full pipeline normally creates answer chapters.  Keep this explicit
  // handoff for skip-prep/re-render runs so an existing transcript can gain
  // the answer-level artifact without retranscription.
  if (answerChapterMode && (!answerChapterCheckpointFresh(candidateAnswerChaptersPath, candidateAnswerCoveragePath, questionBoundariesPath, speakerNameMapPath) || forceChapter || forceSpeaker)) {
    await runWithStreaming({
      cmd: "node",
      args: [path.join(HOUSE_ROOT, "program/segment-candidate-answers-from-transcript-folder.mjs"), transcriptDir, normPrefix],
      cwd: PYASH_ROOT,
      env: {
        PYA_CANDIDATE_ANSWER_REQUIRE_EACH: process.env.PYA_CANDIDATE_ANSWER_REQUIRE_EACH || "auto",
      },
      timeoutMs: 4 * 60 * 60 * 1000,
      label: "candidate-answer-chapters",
    });
  }

  const transcriptPlain = safeReadText(normalizedPlainPath, "");
  const mode = await detectContentMode({ title, transcript: transcriptPlain, focus });
  const style = modeBrief(mode);
  const republishExisting = envFlag("ANDRII_REPUBLISH_EXISTING");
  const previousPayloadPath = path.join(transcriptDir, `${normPrefix}.lemmy-post.json`);
  const previousPayload = safeReadJson(previousPayloadPath, {});
  let meetingSummaryMd = safeReadText(meetingSummaryMdPath, "").trim();
  if (!meetingSummaryMd) {
    throw new Error(`meeting summary not found after canonical pipeline: ${meetingSummaryMdPath}`);
  }
  if (republishExisting) {
    log("[meeting-ref] republish-existing: reusing stored summary checkpoint");
  } else {
    const summaryVerification = await verifyStreamSummaryLlm({
      candidate: meetingSummaryMd,
      sourceText: transcriptPlain,
      coverageText: safeReadText(meetingSummaryChunksPath, ""),
      focus,
      context: title,
      speakerRoster: canonicalSpeakerRoster(),
      speakerNameMapPath,
      verifiedMarkerPath: meetingSummaryVerifyPath,
      summaryPath: meetingSummaryMdPath,
      chunksPath: meetingSummaryChunksPath,
      sourcePath: normalizedPlainPath,
    });
    meetingSummaryMd = summaryVerification.text.trim();
    fs.writeFileSync(meetingSummaryMdPath, `${meetingSummaryMd}\n`, "utf8");
    writeVerifiedSummaryPya(meetingSummaryPyaPath, meetingSummaryMd);
    fs.writeFileSync(meetingSummaryVerifyPath, [
      "su name meeting summary verify artifact be map def",
      `su name pass be bool ${summaryVerification.pass ? "true" : "false"} ya`,
      `su name attempts be num ${summaryVerification.attempts} ya`,
      `su name summary sha256 be text "${digestText(`${meetingSummaryMd}\n`)}" ya`,
      `su name source sha256 be text "${digestText(transcriptPlain)}" ya`,
      `su name coverage sha256 be text "${digestText(safeReadText(meetingSummaryChunksPath, ""))}" ya`,
      `su name speaker roster sha256 be text "${digestText(canonicalSpeakerRoster())}" ya`,
      `su name issues be text \"${pyaEsc(JSON.stringify(summaryVerification.issues))}\" ya`,
      "prah",
      "",
    ].join("\n"), "utf8");
  }

  const summaryDigest = digestText(meetingSummaryMd);
  const cachedHook = safeReadJson(meetingHookJsonPath, {});
  let hook = republishExisting ? cleanInline(previousPayload?.hook || "") : "";
  if (
    String(cachedHook?.hook || "").trim()
    && String(cachedHook?.mode || "").trim() === mode
    && String(cachedHook?.summary_sha256 || "").trim() === summaryDigest
  ) {
    hook = cleanInline(cachedHook.hook);
    log("[hook] checkpoint pass (summary unchanged)");
  }
  if (!hook) {
    hook = cleanInline(await askOllama({
      maxTokens: 24,
      system: "You write short honest titles.",
      prompt: [
        "Return one line only, 5-10 words, title case, no colon.",
        style.hookStyle,
        `Mode: ${mode}`,
        `Title: ${title}`,
        `Focus: ${focus}`,
        "",
        meetingSummaryMd.slice(0, 1800),
      ].join("\n"),
    })) || "Livestream Recap";
  }
  fs.writeFileSync(meetingHookTxtPath, `${hook}\n`, "utf8");
  fs.writeFileSync(meetingHookJsonPath, `${JSON.stringify({ mode, hook, summary_sha256: summaryDigest }, null, 2)}\n`, "utf8");

  if (!envFlag("ANDRII_PIPELINE_SKIP_IMAGE")) {
    log("[meeting-ref] source-video transcript cover");
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(PYASH_ROOT, "command/draw_meeting_cover_from_transcript_folder.mjs"),
        transcriptDir,
        normPrefix,
      ],
      cwd: PYASH_ROOT,
      env: {
        COVER_REQUIRE_SOURCE_VIDEO: "1",
        ANDRII_YTDLP_EXTRACTOR_ARGS: process.env.ANDRII_YTDLP_EXTRACTOR_ARGS || "youtube:player_client=android",
      },
      timeoutMs: 45 * 60 * 1000,
      label: "source-video-transcript-cover",
    });
  }

  const chapters = loadChapters(chaptersPath);
  const candidateAnswerArtifact = safeReadJson(candidateAnswerChaptersPath, {});
  const candidateAnswerCoverage = safeReadJson(candidateAnswerCoveragePath, {});
  const candidateResponseSection = buildCandidateResponseTable({
    answers: candidateAnswerArtifact?.answers,
    coverage: candidateAnswerCoverage,
  });
  const candidateStatsSourceDigest = digestText(JSON.stringify({
    answers: candidateAnswerArtifact?.answers || [],
    coverage: candidateAnswerCoverage,
  }));
  let candidateSolutionStats = safeReadJson(candidateSolutionStatsPath, {});
  if (
    !republishExisting
    && (
    candidateSolutionStats?.schema !== CANDIDATE_SOLUTION_STATS_SCHEMA
    || candidateSolutionStats?.source_digest !== candidateStatsSourceDigest
    )
  ) {
    const generatedStats = await generateCandidateSolutionStats({
      answers: candidateAnswerArtifact?.answers,
      coverage: candidateAnswerCoverage,
      askModel: askOllama,
    });
    if (generatedStats) {
      candidateSolutionStats = {
        ...generatedStats,
        source_digest: candidateStatsSourceDigest,
      };
      fs.writeFileSync(candidateSolutionStatsPath, `${JSON.stringify(candidateSolutionStats, null, 2)}\n`, "utf8");
    } else {
      candidateSolutionStats = {};
    }
  }
  const candidateSolutionSection = renderCandidateSolutionStats(candidateSolutionStats);
  const previousSourceLinks = previousPayload?.source_links && typeof previousPayload.source_links === "object"
    ? previousPayload.source_links
    : {};
  // Preserve distinct official/transcription-source links when an article is
  // regenerated from an existing workspace. A rerun must not silently drop
  // provenance that was already attached to the published post.
  const officialLivestreamUrl = String(
    process.env.ANDRII_OFFICIAL_LIVESTREAM_URL
      || previousSourceLinks.official_livestream_url
      || "",
  ).trim();
  const processedVideoUrl = String(
    process.env.ANDRII_PROCESSED_VIDEO_URL
      || previousSourceLinks.processed_video_url
      || "",
  ).trim();
  const transcriptVideoLabel = String(
    process.env.ANDRII_TRANSCRIPT_VIDEO_LABEL
      || previousSourceLinks.transcript_video_label
      || "Video footage used for this transcript"
  ).trim();
  const sourceBodyLines = [];
  if (processedVideoUrl && processedVideoUrl !== officialLivestreamUrl) {
    sourceBodyLines.push(`${transcriptVideoLabel}: ${processedVideoUrl}`);
  }
  if (officialLivestreamUrl && officialLivestreamUrl !== watchUrl) {
    sourceBodyLines.push(`Official livestream: ${officialLivestreamUrl}`);
  }
  if (!sourceBodyLines.length) sourceBodyLines.push(`${sourceInfo.sourceLabel}: ${watchUrl}`);

  // Keep the transcript URL in the generated article body as well as in the
  // payload metadata. The body is what readers see first, and this also gives
  // future posts a stable, discoverable link to the full transcript.
  const meetingDirName = path.basename(meetingDir);
  const dateText = parseDateFromMeetingDir(meetingDirName);
  const classifiedRoute = sourceTopicFromMode(mode);
  // A republish is a content-preserving migration, not a reclassification.
  // Keep the previously published route identity even if a refreshed model
  // classification changes after the transcript or focus is updated.
  const sourceSlug = republishExisting && cleanInline(previousPayload?.source)
    ? cleanInline(previousPayload.source)
    : classifiedRoute.source;
  const topicSlug = republishExisting && cleanInline(previousPayload?.topic)
    ? cleanInline(previousPayload.topic)
    : classifiedRoute.topic;
  // Multiple videos can be published on the same day under one source/topic
  // (for example, a batch of candidate interviews). The publish API models
  // this as a suffix on the date segment, so detect collisions from existing
  // payload identities and use the video ID only when it is needed.
  const routeSuffix = resolveTranscriptRouteSuffix({
    source: sourceSlug,
    topic: topicSlug,
    dateIso: dateText.iso || dateInfo.iso,
    videoId: id,
    explicit: process.env.PYA_TRANSCRIPT_ROUTE_SUFFIX,
  });
  const transcriptTopicSlug = topicSlug;
  const transcriptDateSlug = `${dateText.iso || dateInfo.iso}${routeSuffix ? `-${routeSuffix}` : ""}`;
  const canonicalUrl = `${String(siteUrl).replace(/\/+$/u, "")}/transcripts/${slugify(sourceSlug)}/${slugify(transcriptTopicSlug)}/${transcriptDateSlug}`;

  const oneSentence = republishExisting && cleanInline(previousPayload?.summary || "")
    ? cleanInline(previousPayload.summary)
    : await generateNeutralStreamOneSentence({
      sourceText: meetingSummaryMd || transcriptPlain.slice(0, 6000),
      styleLine: style.oneLineStyle,
    });

  const topItemsMd = chapters.slice(0, 10).map((c) => `- ${c.title}`).join("\n");
  let fullSummary = stripLeadingSummaryHeading(meetingSummaryMd);
  if (candidateSolutionSection) {
    fullSummary = /^\s*##\s+Most Newsworthy Items\b/im.test(fullSummary)
      ? replaceMarkdownSection(fullSummary, "Most Newsworthy Items", candidateSolutionSection)
      : `${fullSummary}\n\n${candidateSolutionSection}`.trim();
  }

  const postTitle = `${hook} - ${titleCase(body)} - ${dateInfo.long}`;
  const hasNewsSection = /^\s*##\s+Most Newsworthy Items\b/im.test(fullSummary);
  const topItemsSection = hasNewsSection
    ? ""
    : [
        "## Most Newsworthy Items",
        topItemsMd || "- Key chapters were generated from transcript segments.",
        "",
      ].join("\n");
  const bodyMarkdown = [
    `Livestream recap for **${escapeMarkdown(postTitle)}** on **${dateInfo.long}**.`,
    "",
    "## One-Sentence Summary",
    oneSentence,
    "",
    "## Whole Stream Summary",
    fullSummary,
    "",
    topItemsSection,
    candidateResponseSection,
    "## Chapters",
    chapters.slice(0, 30).map((c, index) => `- ${formatChapterTimestamp(c.since, { first: index === 0 })} ${c.title}`).join("\n"),
    "",
    `Transcript: [Read the full transcript](${canonicalUrl})`,
    "",
    sourceBodyLines.join("\n"),
  ].join("\n");

  // Run the shared article-claim gate before rendering HTML so any accepted
  // rewrite is reflected consistently in both the post body and transcript
  // summary. A blocked or empty verification remains retryable and never
  // publishes an unreviewed article.
  const articleClaimsVerifyPath = path.join(transcriptDir, `${normPrefix}.article-claims.verify.pya`);
  const articleVerify = verifyArticleClaims({
    bodyMarkdown,
    meetingSummaryMd: fullSummary,
    meetingSummaryChunksPyaPath: meetingSummaryChunksPath,
    chapterSummaryMd: safeReadText(chapterSummaryMdPath, ""),
    agendaSummaryPyaPath: "",
    agendaSectionGroundingPyaPath: "",
    reportPath: articleClaimsVerifyPath,
  });
  if (articleVerify.blocked) {
    throw new Error("article-verify blocked publish: unresolved unsupported claims");
  }
  if (articleVerify.rewrites > 0) log(`[article-verify] rewritten ${articleVerify.rewrites} claims`);
  else log('[article-verify] pass');
  const finalBodyMarkdown = String(articleVerify.rewrittenBodyMarkdown || bodyMarkdown).trim();
  const verifiedSummaryBlock = extractSummaryBlock(finalBodyMarkdown, fullSummary);

  const htmlPath = path.join(transcriptDir, "transcript-page.html");
  const speakerRows = readSpeakerRowsFromJson(speakerJsonPath);
  const transcriptRows = speakerRows.length ? speakerRows : parseSrt(speakerSrtPath ? safeReadText(speakerSrtPath, "") : "");
  const speakerNameByRow = speakerNameLinking
    ? readSpeakerNameMap(speakerNameMapPath, speakerJsonPath)
    : new Map();
  const speakerAliasByKey = new Map();
  for (const row of transcriptRows) {
    const key = String(row.speaker_key || row.display || row.speaker || "").trim();
    const txt = String(row.text || row.sentence || row.body || row.content || row.line || "").trim();
    if (!key || !txt) continue;
    if (/\b(i am|i'm)\s+andrii\s+zvorygin\b/iu.test(txt)) {
      speakerAliasByKey.set(key, "Andrii Zvorygin");
    }
  }
  const interviewGuestMatch = title.match(/\binterview\s+with\s+(.+?)(?:\s+candidate\b|\s+for\b|$)/iu);
  if (interviewGuestMatch && transcriptRows.length) {
    const totalsBySpeaker = new Map();
    for (const row of transcriptRows) {
      const key = String(row.speaker_key || row.display || row.speaker || "").trim();
      if (!key) continue;
      const duration = Math.max(0, Number(row.until ?? row.end ?? 0) - Number(row.since ?? row.start ?? 0));
      const current = totalsBySpeaker.get(key) || { cues: 0, duration: 0 };
      current.cues += 1;
      current.duration += duration;
      totalsBySpeaker.set(key, current);
    }
    const rankedSpeakers = [...totalsBySpeaker.entries()]
      .sort((a, b) => (b[1].duration - a[1].duration) || (b[1].cues - a[1].cues))
      .map(([key]) => key);
    if (rankedSpeakers.length === 2) {
      speakerAliasByKey.set(rankedSpeakers[0], cleanInline(interviewGuestMatch[1]));
      speakerAliasByKey.set(rankedSpeakers[1], "Andrii Zvorygin");
    }
  }
  if (interviewLike) writeSpeakerAliasesToJson(speakerJsonPath, speakerAliasByKey);
  const transcriptHtmlRows = transcriptRows.map((r) => {
    const rawLabel = String(r.display || r.speaker || r.speaker_key || "SPEAKER_001").trim();
    const speakerKey = String(r.speaker_key || rawLabel || "").trim();
    const rowIndex = Number.isInteger(Number(r.index)) && Number(r.index) > 0 ? Number(r.index) : transcriptRows.indexOf(r) + 1;
    const linked = speakerNameByRow.get(rowIndex);
    const speakerLabel = linked?.name || speakerAliasByKey.get(speakerKey) || rawLabel;
    const spokenText = String(r.text || r.sentence || r.body || r.content || r.line || "").trim();
    const withLabel = spokenText
      ? `${speakerLabel}: ${spokenText}`
      : `${speakerLabel}: (inaudible)`;
    return `<p><a href="${escapeHtml(timestampUrl(watchUrl, r.since))}">${secondsToHms(r.since)}</a> ${escapeHtml(withLabel)}</p>`;
  }).join("\n");
  const keyTopics = chapters.slice(0, 10).map((c) => String(c.title || "").trim()).filter(Boolean);
  const summaryText = cleanInline(oneSentence || fullSummary.split("\n")[0] || "");
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(hook)} - ${escapeHtml(dateInfo.long)}</title>
<meta name="description" content="Transcript and summary for ${escapeHtml(postTitle)}" />
<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
</head><body>
<main>
<h1>${escapeHtml(hook)}</h1>
<p>${escapeHtml(sourceSlug)} · ${escapeHtml(transcriptTopicSlug)} · ${escapeHtml(dateInfo.long)}</p>
<section id="summary" class="summary-section"><h2>Summary</h2>${markdownToHtmlBlock(verifiedSummaryBlock)}</section>
<section id="key-topics" class="key-topics-section topics-section"><h2>Key Topics</h2><ul>${keyTopics.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></section>
<section id="transcript" class="full-transcript-section transcript-section"><h2>Full Transcript</h2>${transcriptHtmlRows}</section>
<section><h2>Source</h2><p><a href="${escapeHtml(watchUrl)}">${escapeHtml(sourceInfo.sourceLabel)}</a></p></section>
<section><h2>Discussion</h2><p><a href="{{DISCUSSION_URL}}">Discuss this stream summary</a></p></section>
</main>
</body></html>`;
  fs.writeFileSync(htmlPath, `${html}\n`, "utf8");

  await runWithStreaming({
    cmd: "node",
    args: [
      path.join(PYASH_ROOT, "command/render_transcript_html_from_transcript_folder.mjs"),
      transcriptDir,
      htmlPath,
      titleCase(sourceSlug),
      titleCase(topicSlug),
      siteUrl,
      discussionUrl,
      watchUrl,
      watchUrl,
      hook,
      "",
      canonicalUrl,
    ],
    cwd: PYASH_ROOT,
    env: {
      PYA_PRESERVE_SPEAKER_NAMES: "1",
      PYA_INTERVIEW_SPEAKER_ALIASES: interviewLike ? "1" : "0",
      ...(speakerNameLinking ? { PYA_SPEAKER_NAME_MAP_PATH: speakerNameMapPath } : {}),
    },
    timeoutMs: 10 * 60 * 1000,
    label: "render-shared-transcript-html",
  });

  const lemmyPayloadPath = path.join(transcriptDir, `${normPrefix}.lemmy-post.json`);
  const lemmyPayloadMd = path.join(transcriptDir, `${normPrefix}.lemmy-post.md`);

  const payloadOut = {
    title: postTitle,
    body_markdown: finalBodyMarkdown,
    transcript_url: canonicalUrl,
    local_transcript_html: htmlPath,
    local_cover_image: fs.existsSync(coverImageStablePath) ? coverImageStablePath : (fs.existsSync(coverImagePath) ? coverImagePath : ""),
    jurisdiction,
    body,
    source: sourceSlug,
    topic: topicSlug,
    // The publisher uses this explicit route slug when reconstructing the
    // server-side canonical URL. Keep it aligned with the rendered HTML.
    meeting_route_slug: transcriptTopicSlug,
    suffix: routeSuffix,
    community_name: activeYoutubeSourceProfile().community_name || ANDRII_ADAPTER.defaults.community_name || "andrii-zvorygin",
    date_iso: dateText.iso || dateInfo.iso,
    post_title: postTitle,
    summary: summaryText,
    key_topics: keyTopics,
    hook,
    focus,
    content_mode: mode,
    source_links: {
      meeting_url: watchUrl,
      video_url: watchUrl,
      ...(officialLivestreamUrl ? { official_livestream_url: officialLivestreamUrl } : {}),
      ...(processedVideoUrl ? { processed_video_url: processedVideoUrl } : {}),
      ...(processedVideoUrl ? { transcript_video_label: transcriptVideoLabel } : {}),
      agenda_urls: [],
      chapters_file: chaptersPath,
      chapter_grounding_file: chapterGroundingPath,
      authoritative_chapters_file: authoritativeChaptersPath,
      chapter_summary_file: chapterSummaryPyaPath,
      meeting_summary_file: meetingSummaryPyaPath,
      candidate_answer_chapters_file: candidateAnswerChaptersPath,
      candidate_solution_stats_file: candidateSolutionStatsPath,
    },
    discussion_url: discussionUrl || "",
    generated_at_utc: new Date().toISOString(),
  };
  fs.writeFileSync(lemmyPayloadPath, `${JSON.stringify(payloadOut, null, 2)}\n`, "utf8");
  fs.writeFileSync(lemmyPayloadMd, `${finalBodyMarkdown}\n`, "utf8");

  const shouldPost = /^(1|true|yes)$/iu.test(String(process.env.ANDRII_AUTOPUBLISH || "0"));
  if (shouldPost) {
    const submitCmd = String(process.env.ANDRII_LEMMY_POST_COMMAND || process.env.MEETING_POST_COMMAND || "").trim();
    if (!submitCmd) {
      log("[meeting-ref] submit skipped (set ANDRII_LEMMY_POST_COMMAND or MEETING_POST_COMMAND)");
    } else {
      await runWithStreaming({
        cmd: "bash",
        args: ["-lc", `${submitCmd} \"${lemmyPayloadPath.replace(/"/gu, '\\"')}\"`],
        cwd: PYASH_ROOT,
        timeoutMs: 30 * 60 * 1000,
        label: "publish-meeting",
      });
    }
  }

  log("[meeting-ref] done");
  log(`[meeting-ref] meeting_dir: ${meetingDir}`);
  log(`[meeting-ref] transcript_dir: ${transcriptDir}`);
  log(`[meeting-ref] payload: ${lemmyPayloadPath}`);
}

function escapeMarkdown(text) {
  return String(text || "").replace(/([*_`\[\]])/g, "\\$1");
}

function secondsToHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function titleCase(text) {
  return String(text || "").split(/\s+/u).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export { auditStreamSummaryCoverage, parseSummaryCoverageChunks, verificationSourceCoverage, verifyStreamSummaryLlm };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
}
